import { useState, useCallback, useMemo, useRef } from "react";
import { generateAIInsights } from "./services/geminiInsights";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine
} from "recharts";

// ── Utility helpers ──────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const parse = (line) => {
    const result = [];
    let current = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === sep && !inQuotes) { result.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  };
  const headers = parse(lines[0]);
  const rows = lines.slice(1).filter(l => l.trim()).map(parse).filter(r => r.length === headers.length);
  return { headers, rows };
}

function detectType(values) {
  const sample = values.filter(v => v !== "" && v != null).slice(0, 100);
  if (sample.length === 0) return "empty";
  const numCount = sample.filter(v => !isNaN(Number(v.toString().replace(",", ".")))).length;
  if (numCount / sample.length > 0.8) return "numeric";
  const datePatterns = [/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/, /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/];
  const dateCount = sample.filter(v => datePatterns.some(p => p.test(v))).length;
  if (dateCount / sample.length > 0.6) return "date";
  const unique = new Set(sample);
  if (unique.size <= Math.min(20, sample.length * 0.3)) return "categorical";
  return "text";
}

function toNum(v) { return Number(v.toString().replace(",", ".")); }

function computeStats(values) {
  const nums = values.filter(v => v !== "" && !isNaN(toNum(v))).map(toNum);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const variance = nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length;
  const std = Math.sqrt(variance);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const outliers = nums.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr).length;
  return { count: nums.length, missing: values.length - nums.length, min: sorted[0], max: sorted[sorted.length - 1], mean, median, std, q1, q3, outliers, sum };
}

function computeCorrelation(xVals, yVals) {
  const pairs = [];
  for (let i = 0; i < xVals.length; i++) {
    const x = toNum(xVals[i]), y = toNum(yVals[i]);
    if (!isNaN(x) && !isNaN(y)) pairs.push([x, y]);
  }
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, dx = 0, dy = 0;
  pairs.forEach(([x, y]) => { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; });
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number(n).toFixed(d).replace(/\.?0+$/, "");
}

// ── Histogram ────────────────────────────────────────────────────
function fmtBinLabel(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function computeHistogram(values) {
  // 1. Filter nulls/undefined/empty/NaN — values arrive as strings from CSV
  const nums = values
    .filter(v => v != null && v !== "" && !isNaN(toNum(v)))
    .map(toNum)
    .filter(isFinite);
  if (nums.length === 0) return [];

  // 2. For low-cardinality columns (binary 0/1, enums, etc.) — direct count
  const unique = [...new Set(nums)];
  if (unique.length <= 5) {
    const conteo = {};
    nums.forEach(v => { conteo[v] = (conteo[v] || 0) + 1; });
    return Object.entries(conteo)
      .map(([val, count]) => ({ rango: fmtBinLabel(Number(val)), count }))
      .sort((a, b) => Number(a.rango.replace(/[KM]$/, "")) - Number(b.rango.replace(/[KM]$/, "")));
  }

  // 3. Adaptive bins for large/normal ranges — loop avoids spread stack overflow
  let min = nums[0], max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (min === max) return [{ rango: fmtBinLabel(min), count: nums.length }];

  const numBins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(nums.length))));
  const step = (max - min) / numBins;

  const buckets = Array.from({ length: numBins }, (_, i) => ({
    rango: fmtBinLabel(min + i * step),
    count: 0,
  }));
  nums.forEach(v => {
    const i = Math.min(Math.floor((v - min) / step), numBins - 1);
    buckets[i].count++;
  });

  // 4. Drop empty bins so Recharts always has data to render
  return buckets.filter(b => b.count > 0);
}

// ── Data Quality ─────────────────────────────────────────────────
function computeDataQuality(headers, rows, types, statsMap) {
  let score = 100;

  // Duplicates
  const rowKeys = rows.map(r => r.join("|"));
  const uniqueKeys = new Set(rowKeys);
  const duplicates = rows.length - uniqueKeys.size;
  const duplicatePct = rows.length > 0 ? duplicates / rows.length : 0;
  if (duplicatePct > 0.05) score -= 15;
  else if (duplicatePct > 0) score -= 5;

  // Nulls per column
  let totalNulls = 0;
  const nullDetails = [];
  headers.forEach((h, i) => {
    const nullCount = rows.filter(r => !r[i] || r[i].trim() === "").length;
    const nullPct = rows.length > 0 ? nullCount / rows.length : 0;
    totalNulls += nullCount;
    if (nullPct > 0.3) score -= 8;
    else if (nullPct > 0.1) score -= 4;
    else if (nullPct > 0) score -= 1;
    if (nullCount > 0) nullDetails.push({ col: h, count: nullCount, pct: nullPct });
  });
  nullDetails.sort((a, b) => b.pct - a.pct);

  // Column name issues
  const badNames = headers.filter(h => /\s/.test(h) || /[áéíóúÁÉÍÓÚñÑ]/.test(h) || h.length > 30);
  if (badNames.length > 0) score -= Math.min(5, badNames.length * 2);

  score = Math.max(0, Math.min(100, Math.round(score)));
  const badge = score >= 80 ? "Bueno" : score >= 50 ? "Atención" : "Crítico";
  const badgeColor = score >= 80 ? "#10B981" : score >= 50 ? "#F59E0B" : "#EF4444";

  return { score, badge, badgeColor, duplicates, duplicatePct, nullDetails, badNames, totalNulls };
}

// ── Recommendations ──────────────────────────────────────────────
function generateRecommendations(headers, rows, types, statsMap, correlations, quality) {
  const recs = [];

  if (quality.duplicates > 0) {
    recs.push({
      priority: "alta", icon: "🗑️",
      text: `Eliminar ${quality.duplicates} filas duplicadas (${(quality.duplicatePct * 100).toFixed(1)}%) para evitar sesgos en el análisis.`,
      action: "Exportar CSV limpio sin duplicados"
    });
  }

  quality.nullDetails.forEach(({ col, count, pct }) => {
    if (pct > 0.3) {
      recs.push({ priority: "alta", icon: "⚠️", text: `"${col}" tiene ${(pct * 100).toFixed(0)}% de valores vacíos. Considera eliminar esta columna o imputar con la media/moda.`, action: "Revisar fuente de datos" });
    } else if (pct > 0.1) {
      recs.push({ priority: "media", icon: "📋", text: `"${col}" tiene ${count} valores nulos (${(pct * 100).toFixed(0)}%). Recomendable imputar antes de modelar.`, action: "Imputar valores" });
    }
  });

  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.outliers > 0) {
      const pct = (s.outliers / s.count * 100).toFixed(0);
      recs.push({ priority: "media", icon: "🎯", text: `"${col}" tiene ${s.outliers} outliers (${pct}% del total). Verifica si son errores de captura o valores legítimos.`, action: "Revisar outliers en la tab Resumen" });
    }
  });

  if (quality.badNames.length > 0) {
    recs.push({ priority: "baja", icon: "✏️", text: `Columnas con nombres problemáticos: ${quality.badNames.map(n => `"${n}"`).join(", ")}. Usa nombres cortos sin espacios ni acentos.`, action: "Renombrar columnas en el CSV original" });
  }

  const dateCols = headers.filter((_, i) => types[i] === "date");
  if (dateCols.length > 0) {
    recs.push({ priority: "baja", icon: "📅", text: `Columnas de fecha detectadas: ${dateCols.map(c => `"${c}"`).join(", ")}. Verifica que el formato sea uniforme (YYYY-MM-DD recomendado).`, action: "Validar formato de fechas" });
  }

  if (recs.length === 0) {
    recs.push({ priority: "ok", icon: "✅", text: "Dataset en buen estado. No se detectaron problemas críticos.", action: "" });
  }

  return recs;
}

// ── Insights ─────────────────────────────────────────────────────
function generateInsights(headers, rows, types, statsMap, correlations) {
  const insights = [];

  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.missing > rows.length * 0.1)
      insights.push({ type: "warning", icon: "⚠️", text: `"${col}" tiene ${s.missing} valores vacíos (${(s.missing / rows.length * 100).toFixed(0)}%). Puede afectar análisis.` });
  });

  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.outliers > 0)
      insights.push({ type: "info", icon: "🔍", text: `"${col}" tiene ${s.outliers} valores atípicos fuera del rango IQR.` });
  });

  correlations.filter(c => Math.abs(c.r) > 0.7).forEach(c => {
    const dir = c.r > 0 ? "positiva" : "negativa";
    insights.push({ type: "success", icon: "📈", text: `Correlación ${dir} fuerte (r=${c.r.toFixed(2)}) entre "${c.a}" y "${c.b}".` });
  });

  headers.forEach((h, i) => {
    if (types[i] === "categorical") {
      const counts = {};
      rows.forEach(r => { const v = r[i]; if (v) counts[v] = (counts[v] || 0) + 1; });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1) {
        const pct = (sorted[0][1] / rows.length * 100).toFixed(0);
        if (Number(pct) > 50)
          insights.push({ type: "info", icon: "🏷️", text: `En "${h}", "${sorted[0][0]}" domina con ${pct}% de los registros.` });
        else
          insights.push({ type: "info", icon: "🏷️", text: `En "${h}", el valor más frecuente es "${sorted[0][0]}" con ${pct}% de registros.` });
      }
    }
  });

  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.mean !== 0 && Math.abs(s.std / s.mean) > 1.5) {
      insights.push({ type: "info", icon: "📊", text: `"${col}" tiene alta variabilidad (CV=${Math.abs(s.std / s.mean).toFixed(1)}x). Los datos están muy dispersos respecto a la media.` });
    }
  });

  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.min >= 0 && s.max > 0 && s.mean > 0) {
      const skew = (s.mean - s.median) / (s.std || 1);
      if (skew > 0.5) insights.push({ type: "info", icon: "↗️", text: `"${col}" muestra asimetría positiva: hay pocos valores muy altos elevando la media (${fmt(s.mean)}) por encima de la mediana (${fmt(s.median)}).` });
      else if (skew < -0.5) insights.push({ type: "info", icon: "↙️", text: `"${col}" muestra asimetría negativa: la media (${fmt(s.mean)}) es menor que la mediana (${fmt(s.median)}).` });
    }
  });

  if (insights.length === 0)
    insights.push({ type: "success", icon: "✅", text: "Datos limpios y consistentes. No se detectaron problemas evidentes." });

  return insights.slice(0, 10);
}

// ── Export helpers ────────────────────────────────────────────────
function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function buildMarkdownReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations) {
  const now = new Date().toLocaleDateString("es-ES");
  let md = `# Informe DataPulse — ${fileName}\n\n`;
  md += `> Generado el ${now} | ${rows.length.toLocaleString()} filas × ${headers.length} columnas\n\n`;

  md += `## Resumen del Dataset\n\n`;
  md += `| Métrica | Valor |\n|---|---|\n`;
  md += `| Filas totales | ${rows.length.toLocaleString()} |\n`;
  md += `| Columnas | ${headers.length} |\n`;
  md += `| Columnas numéricas | ${headers.filter((_, i) => types[i] === "numeric").length} |\n`;
  md += `| Columnas categóricas | ${headers.filter((_, i) => types[i] === "categorical").length} |\n`;
  md += `| Columnas de fecha | ${headers.filter((_, i) => types[i] === "date").length} |\n\n`;

  md += `## Calidad de Datos\n\n`;
  md += `**Score: ${quality.score}/100 — ${quality.badge}**\n\n`;
  md += `- Filas duplicadas: ${quality.duplicates}\n`;
  md += `- Valores nulos totales: ${quality.totalNulls}\n\n`;

  if (quality.nullDetails.length > 0) {
    md += `### Nulos por columna\n\n| Columna | Nulos | % |\n|---|---|---|\n`;
    quality.nullDetails.forEach(({ col, count, pct }) => {
      md += `| ${col} | ${count} | ${(pct * 100).toFixed(1)}% |\n`;
    });
    md += "\n";
  }

  md += `## Estadísticas por Columna\n\n`;
  Object.entries(statsMap).forEach(([col, s]) => {
    if (!s) return;
    md += `### ${col}\n\n| Estadístico | Valor |\n|---|---|\n`;
    md += `| Media | ${fmt(s.mean)} |\n| Mediana | ${fmt(s.median)} |\n`;
    md += `| Desv. estándar | ${fmt(s.std)} |\n| Mínimo | ${fmt(s.min)} |\n`;
    md += `| Máximo | ${fmt(s.max)} |\n| Outliers | ${s.outliers} |\n\n`;
  });

  md += `## Insights Automáticos\n\n`;
  insights.forEach(ins => { md += `- ${ins.icon} ${ins.text}\n`; });

  md += `\n## Recomendaciones\n\n`;
  recommendations.forEach(rec => { md += `- ${rec.icon} **[${rec.priority.toUpperCase()}]** ${rec.text}\n`; });

  md += `\n---\n*Informe generado por DataPulse. Datos procesados localmente en el navegador.*\n`;
  return md;
}

function buildHTMLReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations) {
  const now = new Date().toLocaleDateString("es-ES");
  const bc = quality.badgeColor;

  const statsRows = Object.entries(statsMap).map(([col, s]) => {
    if (!s) return "";
    return `<tr><td>${col}</td><td>${fmt(s.mean)}</td><td>${fmt(s.median)}</td><td>${fmt(s.std)}</td><td>${fmt(s.min)}</td><td>${fmt(s.max)}</td><td>${s.outliers}</td></tr>`;
  }).join("");

  const nullRows = quality.nullDetails.map(({ col, count, pct }) =>
    `<tr><td>${col}</td><td>${count}</td><td>${(pct * 100).toFixed(1)}%</td></tr>`
  ).join("");

  const insightItems = insights.map(ins => `<li>${ins.icon} ${ins.text}</li>`).join("");
  const recItems = recommendations.map(r => `<li><strong>[${r.priority.toUpperCase()}]</strong> ${r.icon} ${r.text}</li>`).join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Informe DataPulse — ${fileName}</title>
<style>
  body{font-family:'Segoe UI',sans-serif;background:#0B1121;color:#F1F5F9;padding:40px;max-width:960px;margin:0 auto;line-height:1.6}
  h1{color:#10B981;margin-bottom:4px}h2{color:#3B82F6;border-bottom:1px solid #1E293B;padding-bottom:8px;margin-top:32px}h3{color:#94A3B8}
  table{border-collapse:collapse;width:100%;margin:16px 0}th{background:#1E293B;color:#94A3B8;padding:8px 12px;text-align:left;font-size:13px}
  td{padding:8px 12px;border-bottom:1px solid #1E293B;font-size:13px}tr:hover td{background:rgba(255,255,255,0.02)}
  .badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:14px;background:${bc}22;color:${bc};border:1px solid ${bc}55}
  .score{font-size:56px;font-weight:800;color:${bc};line-height:1}
  .meta{color:#64748B;font-size:13px;margin:0 0 24px}
  ul{padding-left:20px}li{margin:6px 0;font-size:14px}
  .footer{color:#334155;font-size:12px;margin-top:40px;border-top:1px solid #1E293B;padding-top:16px}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
  .kpi{background:#111827;border:1px solid #1E293B;border-radius:10px;padding:14px}
  .kpi-label{font-size:11px;color:#64748B;margin-bottom:4px}.kpi-value{font-size:22px;font-weight:700;color:#10B981}
</style>
</head>
<body>
<h1>⚡ DataPulse — Informe de análisis</h1>
<p class="meta">Archivo: <strong>${fileName}</strong> &nbsp;|&nbsp; Generado el ${now}</p>

<h2>Resumen del Dataset</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Filas</div><div class="kpi-value">${rows.length.toLocaleString()}</div></div>
  <div class="kpi"><div class="kpi-label">Columnas</div><div class="kpi-value">${headers.length}</div></div>
  <div class="kpi"><div class="kpi-label">Numéricas</div><div class="kpi-value">${headers.filter((_, i) => types[i] === "numeric").length}</div></div>
  <div class="kpi"><div class="kpi-label">Categóricas</div><div class="kpi-value">${headers.filter((_, i) => types[i] === "categorical").length}</div></div>
  <div class="kpi"><div class="kpi-label">Fechas</div><div class="kpi-value">${headers.filter((_, i) => types[i] === "date").length}</div></div>
</div>

<h2>Calidad de Datos</h2>
<div class="score">${quality.score}<span style="font-size:24px;color:#64748B">/100</span></div><br>
<span class="badge">${quality.badge}</span>
<p>Duplicados: <strong>${quality.duplicates}</strong> &nbsp;|&nbsp; Valores nulos totales: <strong>${quality.totalNulls}</strong></p>
${quality.nullDetails.length > 0 ? `<table><tr><th>Columna</th><th>Nulos</th><th>%</th></tr>${nullRows}</table>` : ""}

<h2>Estadísticas por Columna</h2>
${statsRows ? `<table><tr><th>Columna</th><th>Media</th><th>Mediana</th><th>Desv.</th><th>Mín</th><th>Máx</th><th>Outliers</th></tr>${statsRows}</table>` : "<p style='color:#64748B'>No hay columnas numéricas.</p>"}

<h2>Insights Automáticos</h2>
<ul>${insightItems}</ul>

<h2>Recomendaciones</h2>
<ul>${recItems}</ul>

<p class="footer">Informe generado por DataPulse &mdash; Datos procesados localmente en el navegador. No se enviaron datos a ningún servidor.</p>
</body>
</html>`;
}

function buildCleanCSV(headers, rows) {
  const seen = new Set();
  const cleanRows = rows.filter(r => {
    const key = r.join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const esc = v => (v.includes(",") || v.includes('"') || v.includes("\n")) ? `"${v.replace(/"/g, '""')}"` : v;
  return [headers.map(esc).join(","), ...cleanRows.map(r => r.map(esc).join(","))].join("\n");
}

// ── Custom Tooltips ───────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: "monospace", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      {label && <p style={{ color: "#94A3B8", margin: "0 0 6px" }}>{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || "#10B981", margin: "2px 0", fontWeight: 600 }}>
          {p.name}: {typeof p.value === "number" ? fmt(p.value) : p.value}
        </p>
      ))}
    </div>
  );
};

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: "monospace" }}>
      <p style={{ color: "#60A5FA", margin: "2px 0" }}>X: {fmt(d?.x)}</p>
      <p style={{ color: "#10B981", margin: "2px 0" }}>Y: {fmt(d?.y)}</p>
    </div>
  );
};

// ── Brand ─────────────────────────────────────────────────────────
const B = {
  bg: "#0B1121", card: "#111827", cardBorder: "#1E293B",
  accent: "#10B981", accentSoft: "rgba(16,185,129,0.12)",
  blue: "#3B82F6", purple: "#8B5CF6", amber: "#F59E0B",
  red: "#EF4444", pink: "#EC4899",
  textPrimary: "#F1F5F9", textSecondary: "#94A3B8", textMuted: "#64748B",
};

const CHART_COLORS = [B.accent, B.blue, B.purple, B.amber, B.pink, B.red, "#06B6D4", "#84CC16"];

const card = {
  background: B.card, border: `1px solid ${B.cardBorder}`,
  borderRadius: 12, padding: 20, marginBottom: 16,
};

// ── Priority badge helper ─────────────────────────────────────────
function PriorityBadge({ priority }) {
  const map = {
    alta: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)", color: "#FCA5A5", label: "Alta" },
    media: { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)", color: "#FCD34D", label: "Media" },
    baja: { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)", color: "#93C5FD", label: "Baja" },
    ok: { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.3)", color: "#6EE7B7", label: "OK" },
  };
  const s = map[priority] || map.baja;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: s.bg, border: `1px solid ${s.border}`, color: s.color, letterSpacing: "0.05em" }}>
      {s.label}
    </span>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function DataPulse() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("resumen");

  const [catFilters, setCatFilters] = useState({});
  const [numFilters, setNumFilters] = useState({});

  const [explorerX, setExplorerX] = useState("");
  const [explorerY, setExplorerY] = useState("");
  const [explorerType, setExplorerType] = useState("bar");

  // AI insights state
  const [aiInsights, setAiInsights] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  const fileRef = useRef();

  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result);
      if (parsed.rows.length === 0) return;
      setData(parsed);

      const types = parsed.headers.map((_, i) => detectType(parsed.rows.map(r => r[i])));
      const statsMap = {};
      parsed.headers.forEach((h, i) => {
        if (types[i] === "numeric") statsMap[h] = computeStats(parsed.rows.map(r => r[i]));
      });
      const numericCols = parsed.headers.filter((_, i) => types[i] === "numeric");
      const correlations = [];
      for (let i = 0; i < numericCols.length; i++) {
        for (let j = i + 1; j < numericCols.length; j++) {
          const ai = parsed.headers.indexOf(numericCols[i]);
          const bi = parsed.headers.indexOf(numericCols[j]);
          const r = computeCorrelation(parsed.rows.map(r => r[ai]), parsed.rows.map(r => r[bi]));
          if (r != null) correlations.push({ a: numericCols[i], b: numericCols[j], r });
        }
      }
      const catBreakdowns = {};
      parsed.headers.forEach((h, i) => {
        if (types[i] === "categorical") {
          const counts = {};
          parsed.rows.forEach(r => { const v = r[i]; if (v) counts[v] = (counts[v] || 0) + 1; });
          catBreakdowns[h] = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([label, value]) => ({ label, value }));
        }
      });

      const initCat = {};
      parsed.headers.forEach((h, i) => {
        if (types[i] === "categorical") {
          const vals = [...new Set(parsed.rows.map(r => r[i]).filter(Boolean))];
          initCat[h] = new Set(vals);
        }
      });
      const initNum = {};
      parsed.headers.forEach((h, i) => {
        if (types[i] === "numeric") {
          const s = statsMap[h];
          if (s) initNum[h] = [s.min, s.max];
        }
      });

      const quality = computeDataQuality(parsed.headers, parsed.rows, types, statsMap);
      const insights = generateInsights(parsed.headers, parsed.rows, types, statsMap, correlations);
      const recommendations = generateRecommendations(parsed.headers, parsed.rows, types, statsMap, correlations, quality);

      setCatFilters(initCat);
      setNumFilters(initNum);
      setExplorerX(numericCols[0] || "");
      setExplorerY(numericCols[1] || numericCols[0] || "");
      setAnalysis({ types, statsMap, correlations, catBreakdowns, insights, quality, recommendations });
      setAiInsights(null);
      setAiError(null);
      setActiveTab("resumen");
    };
    reader.readAsText(file);
  }, []);

  // ── Filtered rows ─────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter(row => {
      for (const [col, allowed] of Object.entries(catFilters)) {
        const idx = data.headers.indexOf(col);
        if (idx >= 0 && allowed.size > 0 && !allowed.has(row[idx])) return false;
      }
      for (const [col, [mn, mx]] of Object.entries(numFilters)) {
        const idx = data.headers.indexOf(col);
        if (idx >= 0) {
          const v = toNum(row[idx]);
          if (!isNaN(v) && (v < mn || v > mx)) return false;
        }
      }
      return true;
    });
  }, [data, catFilters, numFilters]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // ── Explorer data ─────────────────────────────────────────────
  const explorerData = useMemo(() => {
    if (!data || !analysis || !explorerX) return [];
    const { headers } = data;
    const { types } = analysis;
    const xIdx = headers.indexOf(explorerX);
    const yIdx = explorerY ? headers.indexOf(explorerY) : -1;
    if (xIdx < 0) return [];
    if (types[xIdx] === "categorical") {
      const counts = {};
      filteredRows.forEach(r => {
        const k = r[xIdx] || "(vacío)";
        if (!counts[k]) counts[k] = { label: k, count: 0, sum: 0, n: 0 };
        counts[k].count++;
        if (yIdx >= 0) {
          const v = toNum(r[yIdx]);
          if (!isNaN(v)) { counts[k].sum += v; counts[k].n++; }
        }
      });
      return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 20)
        .map(d => ({ label: d.label, value: yIdx >= 0 && d.n > 0 ? d.sum / d.n : d.count }));
    } else {
      return filteredRows.slice(0, 500).map((r, i) => ({
        x: toNum(r[xIdx]),
        y: yIdx >= 0 ? toNum(r[yIdx]) : i,
      })).filter(d => !isNaN(d.x) && !isNaN(d.y));
    }
  }, [data, analysis, explorerX, explorerY, filteredRows]);

  // ── Upload Screen ─────────────────────────────────────────────
  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: B.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', monospace", padding: 20 }}>
        <div style={{ textAlign: "center", maxWidth: 540 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 36, fontWeight: 800, color: B.textPrimary, letterSpacing: "-0.03em", margin: "0 0 4px", background: `linear-gradient(135deg, ${B.accent}, ${B.blue})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            DataPulse
          </h1>
          <p style={{ color: B.textMuted, fontSize: 13, margin: "0 0 6px", letterSpacing: "0.05em" }}>by ErnestoLab</p>
          <p style={{ color: B.textSecondary, fontSize: 14, margin: "0 0 8px" }}>Analista automático de CSV · 100% local · sin APIs externas</p>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap", margin: "0 0 28px" }}>
            {["Calidad de datos", "KPIs automáticos", "Histogramas", "Correlaciones", "Insights", "Exportar informe"].map(f => (
              <span key={f} style={{ fontSize: 11, color: B.accent, background: B.accentSoft, border: `1px solid rgba(16,185,129,0.25)`, borderRadius: 20, padding: "3px 10px" }}>{f}</span>
            ))}
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? B.accent : B.cardBorder}`, borderRadius: 16, padding: "48px 32px", cursor: "pointer", background: dragOver ? B.accentSoft : "rgba(17,24,39,0.6)", transition: "all 0.2s" }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
            <p style={{ color: B.textPrimary, fontSize: 15, margin: "0 0 6px", fontWeight: 600 }}>Arrastra tu CSV aquí</p>
            <p style={{ color: B.textMuted, fontSize: 13, margin: 0 }}>o haz clic para seleccionar archivo</p>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
          </div>
          <div style={{ marginTop: 20, padding: "12px 16px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, fontSize: 12, color: B.textMuted, lineHeight: 1.6 }}>
            <span style={{ color: B.amber }}>⚠️ Aviso de privacidad:</span> No subas información sensible si no confías en el entorno.<br />
            Los datos se procesan <strong style={{ color: B.textSecondary }}>exclusivamente en tu navegador</strong> y nunca se envían a servidores externos.
          </div>
        </div>
      </div>
    );
  }

  const { headers, rows } = data;
  const { types, statsMap, correlations, catBreakdowns, insights, quality, recommendations } = analysis;
  const numericCols = headers.filter((_, i) => types[i] === "numeric");
  const catCols = headers.filter((_, i) => types[i] === "categorical");
  const dateCols = headers.filter((_, i) => types[i] === "date");

  const activeFiltersCount = Object.entries(catFilters).reduce((acc, [col, s]) => {
    const allVals = [...new Set(rows.map(r => r[headers.indexOf(col)]).filter(Boolean))];
    return acc + (s.size < allVals.length ? 1 : 0);
  }, 0) + Object.entries(numFilters).reduce((acc, [col, [mn, mx]]) => {
    const s = statsMap[col];
    return acc + (s && (mn > s.min || mx < s.max) ? 1 : 0);
  }, 0);

  const tabs = [
    { id: "resumen", label: "Resumen", icon: "📊" },
    { id: "calidad", label: "Calidad", icon: "🏅" },
    { id: "explorador", label: "Explorador", icon: "🔭" },
    { id: "filtros", label: `Filtros${activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ""}`, icon: "🎛️" },
    { id: "correlaciones", label: "Correlaciones", icon: "🔗" },
    { id: "insights", label: "Insights", icon: "💡" },
    { id: "datos", label: "Datos", icon: "📄" },
    { id: "exportar", label: "Exportar", icon: "📥" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: "'JetBrains Mono', monospace", color: B.textPrimary }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${B.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${B.accent}, ${B.blue})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>DataPulse</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          {activeFiltersCount > 0 && (
            <span style={{ fontSize: 11, color: B.amber, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "3px 8px" }}>
              🎛️ {activeFiltersCount} filtro{activeFiltersCount > 1 ? "s" : ""} activo{activeFiltersCount > 1 ? "s" : ""} — {filteredRows.length.toLocaleString()} filas
            </span>
          )}
          <span style={{ fontSize: 11, color: quality.badgeColor, background: `${quality.badgeColor}18`, border: `1px solid ${quality.badgeColor}44`, borderRadius: 6, padding: "3px 8px", fontWeight: 600 }}>
            🏅 {quality.score}/100 {quality.badge}
          </span>
          <span style={{ color: B.textMuted, fontSize: 12 }}>📄 {fileName}</span>
          <button
            onClick={() => { setData(null); setAnalysis(null); setFileName(""); setCatFilters({}); setNumFilters({}); }}
            style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#FCA5A5", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
          >
            Nuevo archivo
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ padding: "20px 24px 8px", display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { label: "Filas (filtradas)", value: `${filteredRows.length.toLocaleString()} / ${rows.length.toLocaleString()}`, icon: "📐", color: B.accent },
          { label: "Columnas", value: headers.length, icon: "📊", color: B.blue },
          { label: "Numéricas", value: numericCols.length, icon: "🔢", color: B.purple },
          { label: "Categóricas", value: catCols.length, icon: "🏷️", color: B.amber },
          { label: "Fechas", value: dateCols.length, icon: "📅", color: B.pink },
          { label: "Duplicados", value: quality.duplicates, icon: "♻️", color: quality.duplicates > 0 ? B.red : B.accent },
          { label: "Nulos totales", value: quality.totalNulls, icon: "◻️", color: quality.totalNulls > 0 ? B.amber : B.accent },
        ].map((kpi, i) => (
          <div key={i} style={{ flex: "1 1 120px", ...card, marginBottom: 0, padding: "12px 14px", borderLeft: `3px solid ${kpi.color}` }}>
            <div style={{ fontSize: 10, color: B.textMuted, marginBottom: 4 }}>{kpi.icon} {kpi.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ padding: "16px 24px 0", display: "flex", gap: 4, borderBottom: `1px solid ${B.cardBorder}`, overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background: activeTab === t.id ? B.accentSoft : "transparent",
            border: "none", borderBottom: activeTab === t.id ? `2px solid ${B.accent}` : "2px solid transparent",
            color: activeTab === t.id ? B.accent : B.textMuted,
            padding: "10px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            fontWeight: activeTab === t.id ? 600 : 400, whiteSpace: "nowrap", transition: "all 0.15s",
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "20px 24px 60px" }}>

        {/* ── RESUMEN ── */}
        {activeTab === "resumen" && (
          <div>
            {/* Dataset overview */}
            <div style={{ ...card, marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 14px", color: B.textSecondary }}>📋 Vista general del dataset</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                {[
                  { label: "Total de filas", value: rows.length.toLocaleString(), color: B.accent },
                  { label: "Total de columnas", value: headers.length, color: B.blue },
                  { label: "Columnas numéricas", value: numericCols.length, color: B.purple },
                  { label: "Columnas categóricas", value: catCols.length, color: B.amber },
                  { label: "Columnas de fecha", value: dateCols.length, color: B.pink },
                  { label: "Columnas de texto", value: headers.filter((_, i) => types[i] === "text" || types[i] === "empty").length, color: B.textMuted },
                ].map((item, i) => (
                  <div key={i} style={{ padding: "10px 14px", background: "#0d1626", borderRadius: 8, borderLeft: `3px solid ${item.color}` }}>
                    <div style={{ fontSize: 10, color: B.textMuted, marginBottom: 2 }}>{item.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Column type table */}
              <div style={{ marginTop: 16, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "rgba(30,41,59,0.4)" }}>
                      {["Columna", "Tipo detectado", "Valores únicos", "Nulos", "Muestra"].map(h => (
                        <th key={h} style={{ padding: "7px 10px", color: B.textMuted, textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {headers.map((h, i) => {
                      const colVals = rows.map(r => r[i]);
                      const nulls = colVals.filter(v => !v || v.trim() === "").length;
                      const uniques = new Set(colVals.filter(Boolean)).size;
                      const sample = colVals.find(v => v && v.trim() !== "") || "—";
                      const typeColors = { numeric: B.purple, categorical: B.amber, date: B.pink, text: B.blue, empty: B.red };
                      return (
                        <tr key={h} style={{ borderTop: `1px solid ${B.cardBorder}` }}>
                          <td style={{ padding: "6px 10px", color: B.textPrimary, fontWeight: 600 }}>{h}</td>
                          <td style={{ padding: "6px 10px" }}>
                            <span style={{ fontSize: 10, color: typeColors[types[i]] || B.textMuted, background: `${typeColors[types[i]]}18`, padding: "2px 7px", borderRadius: 4 }}>{types[i]}</span>
                          </td>
                          <td style={{ padding: "6px 10px", color: B.textSecondary }}>{uniques.toLocaleString()}</td>
                          <td style={{ padding: "6px 10px", color: nulls > 0 ? B.amber : B.textMuted }}>{nulls > 0 ? nulls : "—"}</td>
                          <td style={{ padding: "6px 10px", color: B.textMuted, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sample}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* First rows preview */}
            <div style={{ ...card, marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px", color: B.textSecondary }}>👁️ Primeras filas</h2>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
                  <thead>
                    <tr style={{ background: "rgba(30,41,59,0.4)" }}>
                      <th style={{ padding: "7px 10px", color: B.textMuted }}>#</th>
                      {headers.map(h => <th key={h} style={{ padding: "7px 10px", color: B.textMuted, textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, ri) => (
                      <tr key={ri} style={{ borderTop: `1px solid ${B.cardBorder}` }}>
                        <td style={{ padding: "6px 10px", color: B.textMuted, textAlign: "center" }}>{ri + 1}</td>
                        {r.map((v, ci) => <td key={ci} style={{ padding: "6px 10px", color: B.textSecondary, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Numeric columns: line chart + stats + histogram */}
            {numericCols.length > 0 && (
              <div>
                <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 14px" }}>🔢 Columnas numéricas</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
                  {numericCols.map(col => {
                    const s = statsMap[col];
                    const idx = headers.indexOf(col);
                    const lineData = filteredRows.slice(0, 80).map((r, i) => ({ i, v: toNum(r[idx]) })).filter(d => !isNaN(d.v));
                    const histData = computeHistogram(filteredRows.map(r => r[idx]));
                    return (
                      <div key={col} style={card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: B.blue }}>🔢 {col}</span>
                          <span style={{ fontSize: 10, color: B.textMuted, background: "rgba(59,130,246,0.1)", padding: "2px 8px", borderRadius: 4 }}>numérica</span>
                        </div>
                        {/* Line chart */}
                        <ResponsiveContainer width="100%" height={70}>
                          <LineChart data={lineData}>
                            <Line type="monotone" dataKey="v" stroke={B.blue} strokeWidth={2} dot={false} />
                            <Tooltip content={<CustomTooltip />} />
                            <ReferenceLine y={s?.mean} stroke={B.accent} strokeDasharray="3 3" />
                          </LineChart>
                        </ResponsiveContainer>
                        {/* Stats grid */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, margin: "10px 0" }}>
                          {[["Media", fmt(s?.mean)], ["Mediana", fmt(s?.median)], ["Desv.", fmt(s?.std)],
                            ["Mín", fmt(s?.min)], ["Máx", fmt(s?.max)], ["Outliers", s?.outliers ?? "—"]].map(([l, v], i) => (
                            <div key={i} style={{ fontSize: 11 }}>
                              <span style={{ color: B.textMuted }}>{l}: </span>
                              <span style={{ color: B.textPrimary, fontWeight: 600 }}>{v}</span>
                            </div>
                          ))}
                        </div>
                        {/* Histogram */}
                        <div style={{ borderTop: `1px solid ${B.cardBorder}`, paddingTop: 10 }}>
                          <div style={{ fontSize: 10, color: B.textMuted, marginBottom: 6 }}>Distribución</div>
                          <ResponsiveContainer width="100%" height={80}>
                            <BarChart data={histData} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                              <XAxis dataKey="rango" tick={{ fill: B.textMuted, fontSize: 9 }} interval="preserveStartEnd" />
                              <YAxis tick={{ fill: B.textMuted, fontSize: 9 }} />
                              <Tooltip
                                content={<CustomTooltip />}
                                cursor={{ fill: "rgba(128,128,128,0.1)" }}
                                contentStyle={{ background: B.card, border: `0.5px solid ${B.cardBorder}`, borderRadius: 8, fontSize: 12 }}
                              />
                              <Bar dataKey="count" fill={B.purple} radius={[2, 2, 0, 0]} fillOpacity={0.8} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        {s?.outliers > 0 && (
                          <div style={{ marginTop: 8, fontSize: 11, color: B.amber, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 6, padding: "5px 10px" }}>
                            ⚠️ {s.outliers} outlier{s.outliers > 1 ? "s" : ""} detectado{s.outliers > 1 ? "s" : ""} (IQR: {fmt(s.q1)} — {fmt(s.q3)})
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Categorical columns */}
            {catCols.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 14px" }}>🏷️ Columnas categóricas</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
                  {catCols.map(col => {
                    const idx = headers.indexOf(col);
                    const counts = {};
                    filteredRows.forEach(r => { const v = r[idx]; if (v) counts[v] = (counts[v] || 0) + 1; });
                    const chartData = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }));
                    const total = chartData.reduce((a, d) => a + d.value, 0);
                    return (
                      <div key={col} style={card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: B.amber }}>🏷️ {col}</span>
                          <span style={{ fontSize: 10, color: B.textMuted, background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4 }}>{Object.keys(counts).length} valores únicos</span>
                        </div>
                        <ResponsiveContainer width="100%" height={160}>
                          <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 30 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                            <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                            <YAxis tick={{ fill: B.textMuted, fontSize: 10 }} />
                            <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                              {chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <div style={{ marginTop: 8, fontSize: 11, color: B.textMuted }}>
                          Top: <span style={{ color: B.amber, fontWeight: 600 }}>{chartData[0]?.label}</span> ({chartData[0] ? (chartData[0].value / total * 100).toFixed(0) : 0}%)
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── CALIDAD ── */}
        {activeTab === "calidad" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🏅 Calidad del dataset</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 20px" }}>Análisis automático de problemas de calidad en los datos.</p>

            {/* Score card */}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 20, marginBottom: 20 }}>
              <div style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "28px 40px" }}>
                <div style={{ fontSize: 64, fontWeight: 800, color: quality.badgeColor, lineHeight: 1 }}>{quality.score}</div>
                <div style={{ fontSize: 16, color: B.textMuted, marginBottom: 10 }}>/100</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: quality.badgeColor, background: `${quality.badgeColor}18`, border: `1px solid ${quality.badgeColor}44`, borderRadius: 20, padding: "4px 16px" }}>{quality.badge}</div>
              </div>
              <div style={{ ...card, marginBottom: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>Resumen de problemas</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[
                    { label: "Filas duplicadas", value: quality.duplicates, total: rows.length, bad: quality.duplicates > 0, color: quality.duplicates > 0 ? B.red : B.accent },
                    { label: "Valores nulos totales", value: quality.totalNulls, total: rows.length * headers.length, bad: quality.totalNulls > 0, color: quality.totalNulls > 0 ? B.amber : B.accent },
                    { label: "Columnas con nulos", value: quality.nullDetails.length, total: headers.length, bad: quality.nullDetails.length > 0, color: quality.nullDetails.length > 0 ? B.amber : B.accent },
                    { label: "Nombres problemáticos", value: quality.badNames.length, total: headers.length, bad: quality.badNames.length > 0, color: quality.badNames.length > 0 ? B.blue : B.accent },
                  ].map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 140, fontSize: 11, color: B.textMuted, flexShrink: 0 }}>{item.label}</div>
                      <div style={{ flex: 1, height: 6, background: B.cardBorder, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.min(100, item.value / item.total * 100)}%`, background: item.color, borderRadius: 3, transition: "width 0.5s" }} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: item.color, minWidth: 30, textAlign: "right" }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Null analysis per column */}
            {quality.nullDetails.length > 0 && (
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>◻️ Valores nulos por columna</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {quality.nullDetails.map(({ col, count, pct }) => {
                    const color = pct > 0.3 ? B.red : pct > 0.1 ? B.amber : B.blue;
                    return (
                      <div key={col} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 140, fontSize: 11, color: B.textPrimary, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{col}</div>
                        <div style={{ flex: 1, height: 8, background: B.cardBorder, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 4 }} />
                        </div>
                        <div style={{ fontSize: 11, color, fontWeight: 600, minWidth: 70, textAlign: "right" }}>{count} ({(pct * 100).toFixed(1)}%)</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Duplicates */}
            <div style={{ ...card }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.textSecondary, marginBottom: 10 }}>♻️ Duplicados</div>
              {quality.duplicates === 0 ? (
                <p style={{ color: B.accent, fontSize: 13, margin: 0 }}>✅ No se detectaron filas duplicadas.</p>
              ) : (
                <div>
                  <p style={{ color: B.red, fontSize: 13, margin: "0 0 8px" }}>
                    Se detectaron <strong>{quality.duplicates}</strong> filas duplicadas ({(quality.duplicatePct * 100).toFixed(1)}% del total).
                  </p>
                  <p style={{ color: B.textMuted, fontSize: 12, margin: 0 }}>Usa "Exportar → CSV limpio" para obtener el dataset sin duplicados.</p>
                </div>
              )}
            </div>

            {/* Column name issues */}
            {quality.badNames.length > 0 && (
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: B.textSecondary, marginBottom: 10 }}>✏️ Nombres de columna problemáticos</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {quality.badNames.map(n => (
                    <span key={n} style={{ fontSize: 12, color: B.blue, background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: 6, padding: "4px 10px" }}>{n}</span>
                  ))}
                </div>
                <p style={{ color: B.textMuted, fontSize: 11, margin: "10px 0 0" }}>Recomendación: usa nombres cortos en minúsculas sin espacios ni acentos (ej. <code style={{ color: B.accent }}>nombre_columna</code>).</p>
              </div>
            )}

            {/* Recommendations */}
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>🔧 Recomendaciones accionables</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recommendations.map((rec, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", background: "#0d1626", borderRadius: 8, border: `1px solid ${B.cardBorder}` }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{rec.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: B.textPrimary, lineHeight: 1.5 }}>{rec.text}</div>
                      {rec.action && <div style={{ fontSize: 11, color: B.textMuted, marginTop: 4 }}>→ {rec.action}</div>}
                    </div>
                    <PriorityBadge priority={rec.priority} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── EXPLORADOR ── */}
        {activeTab === "explorador" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>🔭 Explorador de variables</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 20px" }}>Selecciona variables para cruzarlas y visualizarlas. Los filtros activos se aplican aquí también.</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Eje X / Variable principal</label>
                <select value={explorerX} onChange={e => setExplorerX(e.target.value)} style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Eje Y / Métrica</label>
                <select value={explorerY} onChange={e => setExplorerY(e.target.value)} style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  <option value="">— conteo —</option>
                  {numericCols.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Tipo de gráfica</label>
                <select value={explorerType} onChange={e => setExplorerType(e.target.value)} style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  <option value="bar">Barras</option>
                  <option value="line">Líneas</option>
                  <option value="scatter">Dispersión</option>
                </select>
              </div>
            </div>
            <div style={{ ...card, padding: 24 }}>
              <div style={{ marginBottom: 12, fontSize: 13, color: B.textSecondary }}>
                <strong style={{ color: B.textPrimary }}>{explorerX}</strong>
                {explorerY && <> vs <strong style={{ color: B.accent }}>{explorerY}</strong></>}
                <span style={{ color: B.textMuted, marginLeft: 8 }}>({filteredRows.length.toLocaleString()} registros)</span>
              </div>
              {explorerType === "scatter" ? (
                numericCols.includes(explorerX) ? (
                <ResponsiveContainer width="100%" height={360}>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                    <XAxis type="number" dataKey="x" name={explorerX} tick={{ fill: B.textMuted, fontSize: 11 }} label={{ value: explorerX, position: "insideBottom", offset: -10, fill: B.textMuted, fontSize: 11 }} />
                    <YAxis type="number" dataKey="y" name={explorerY || "índice"} tick={{ fill: B.textMuted, fontSize: 11 }} />
                    <Tooltip content={<ScatterTooltip />} cursor={{ fill: "transparent" }} />
                    <Scatter data={explorerData.slice(0, 500)} fill={B.accent} fillOpacity={0.65} r={3} />
                  </ScatterChart>
                </ResponsiveContainer>
                ) : (
                  <div style={{ height: 360, display: "flex", alignItems: "center", justifyContent: "center", color: B.textMuted, fontSize: 13 }}>
                    Selecciona una columna numérica en Eje X para usar el gráfico de dispersión.
                  </div>
                )
              ) : explorerType === "line" ? (
                <ResponsiveContainer width="100%" height={360}>
                  <LineChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                    <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval="preserveStartEnd" />
                    <YAxis tick={{ fill: B.textMuted, fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Line type="monotone" dataKey="value" stroke={B.blue} strokeWidth={2} dot={{ fill: B.blue, r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                    <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                    <YAxis tick={{ fill: B.textMuted, fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {explorerData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* ── FILTROS ── */}
        {activeTab === "filtros" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>🎛️ Filtros</h2>
                <p style={{ color: B.textMuted, fontSize: 12, margin: 0 }}>
                  Mostrando <strong style={{ color: B.accent }}>{filteredRows.length.toLocaleString()}</strong> de {rows.length.toLocaleString()} filas
                </p>
              </div>
              <button onClick={() => {
                const initCat = {};
                headers.forEach((h, i) => {
                  if (types[i] === "categorical") initCat[h] = new Set([...new Set(rows.map(r => r[i]).filter(Boolean))]);
                });
                const initNum = {};
                headers.forEach((h, i) => {
                  if (types[i] === "numeric" && statsMap[h]) initNum[h] = [statsMap[h].min, statsMap[h].max];
                });
                setCatFilters(initCat);
                setNumFilters(initNum);
              }} style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", color: "#FCA5A5", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                Resetear filtros
              </button>
            </div>

            {catCols.map(col => {
              const idx = headers.indexOf(col);
              const allVals = [...new Set(rows.map(r => r[idx]).filter(Boolean))].sort();
              const selected = catFilters[col] || new Set(allVals);
              return (
                <div key={col} style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: B.amber }}>🏷️ {col}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set(allVals) }))} style={{ fontSize: 11, color: B.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Todo</button>
                      <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set() }))} style={{ fontSize: 11, color: B.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Ninguno</button>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {allVals.map(val => {
                      const active = selected.has(val);
                      return (
                        <button key={val} onClick={() => {
                          setCatFilters(p => {
                            const next = new Set(p[col] || allVals);
                            active ? next.delete(val) : next.add(val);
                            return { ...p, [col]: next };
                          });
                        }} style={{ padding: "4px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", fontFamily: "inherit", border: `1px solid ${active ? B.amber : B.cardBorder}`, background: active ? "rgba(245,158,11,0.15)" : "transparent", color: active ? B.amber : B.textMuted, transition: "all 0.15s" }}>
                          {val}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {numericCols.map(col => {
              const s = statsMap[col];
              if (!s) return null;
              const [mn, mx] = numFilters[col] || [s.min, s.max];
              return (
                <div key={col} style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: B.blue }}>🔢 {col}</span>
                    <span style={{ fontSize: 11, color: B.textMuted }}>{fmt(mn)} — {fmt(mx)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: B.textMuted, display: "block", marginBottom: 4 }}>Mínimo</label>
                      <input type="range" min={s.min} max={s.max} step={(s.max - s.min) / 100} value={mn}
                        onChange={e => setNumFilters(p => ({ ...p, [col]: [parseFloat(e.target.value), mx] }))}
                        style={{ width: "100%", accentColor: B.blue }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: B.textMuted, display: "block", marginBottom: 4 }}>Máximo</label>
                      <input type="range" min={s.min} max={s.max} step={(s.max - s.min) / 100} value={mx}
                        onChange={e => setNumFilters(p => ({ ...p, [col]: [mn, parseFloat(e.target.value)] }))}
                        style={{ width: "100%", accentColor: B.blue }} />
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: B.textMuted }}>Rango original: {fmt(s.min)} — {fmt(s.max)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── CORRELACIONES ── */}
        {activeTab === "correlaciones" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>Matriz de correlaciones</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>Valores entre -1 (inversa perfecta) y +1 (directa perfecta). Verde = positiva fuerte, rojo = negativa fuerte.</p>
            {numericCols.length < 2 ? (
              <div style={card}><p style={{ color: B.textMuted, fontSize: 13 }}>Se necesitan al menos 2 columnas numéricas.</p></div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 8 }}></th>
                      {numericCols.map(c => <th key={c} style={{ padding: 8, color: B.textMuted, fontWeight: 600, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {numericCols.map((a) => (
                      <tr key={a}>
                        <td style={{ padding: 8, fontWeight: 600, color: B.textSecondary, whiteSpace: "nowrap" }}>{a}</td>
                        {numericCols.map((b) => {
                          if (a === b) return <td key={b} style={{ padding: 8, textAlign: "center", color: B.textMuted }}>1.00</td>;
                          const c = correlations.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
                          const r = c ? c.r : null;
                          const abs = r != null ? Math.abs(r) : 0;
                          const bg = abs > 0.7 ? (r > 0 ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)") : abs > 0.4 ? "rgba(245,158,11,0.12)" : "transparent";
                          return (
                            <td key={b} style={{ padding: 8, textAlign: "center", background: bg, borderRadius: 4, color: B.textPrimary, fontWeight: abs > 0.7 ? 700 : 400 }}>
                              {r != null ? r.toFixed(2) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── INSIGHTS ── */}
        {activeTab === "insights" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>💡 Insights automáticos</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>Hallazgos detectados automáticamente mediante análisis estadístico.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
              {insights.map((ins, i) => {
                const colors = {
                  warning: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.3)" },
                  info: { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.3)" },
                  success: { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.3)" }
                };
                const c = colors[ins.type] || colors.info;
                return (
                  <div key={i} style={{ padding: "14px 16px", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 13, lineHeight: 1.6 }}>
                    {ins.icon} {ins.text}
                  </div>
                );
              })}
            </div>

            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>🔧 Recomendaciones accionables</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>Acciones sugeridas para mejorar la calidad del dataset.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {recommendations.map((rec, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 10 }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>{rec.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: B.textPrimary, lineHeight: 1.6 }}>{rec.text}</div>
                    {rec.action && <div style={{ fontSize: 11, color: B.textMuted, marginTop: 4 }}>→ {rec.action}</div>}
                  </div>
                  <PriorityBadge priority={rec.priority} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── DATOS ── */}
        {activeTab === "datos" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>Vista de datos</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>
              Mostrando {Math.min(100, filteredRows.length)} de {filteredRows.length.toLocaleString()} filas filtradas.
            </p>
            <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${B.cardBorder}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "rgba(30,41,59,0.5)" }}>
                    <th style={{ padding: "8px 10px", color: B.textMuted, textAlign: "center" }}>#</th>
                    {headers.map(h => <th key={h} style={{ padding: "8px 10px", color: B.textMuted, textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, 100).map((r, ri) => (
                    <tr key={ri} style={{ borderTop: `1px solid ${B.cardBorder}` }}>
                      <td style={{ padding: "6px 10px", color: B.textMuted, textAlign: "center" }}>{ri + 1}</td>
                      {r.map((v, ci) => (
                        <td key={ci} style={{ padding: "6px 10px", color: v ? B.textSecondary : B.textMuted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: v ? "normal" : "italic" }}>{v || "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── EXPORTAR ── */}
        {activeTab === "exportar" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>📥 Exportar</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 24px" }}>Descarga el informe o los datos limpios. Todo se genera localmente en tu navegador.</p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>

              {/* Markdown */}
              <div style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>📝</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: B.textPrimary, marginBottom: 6 }}>Informe Markdown</div>
                <div style={{ fontSize: 12, color: B.textMuted, lineHeight: 1.6, flex: 1, marginBottom: 16 }}>
                  Informe completo en formato <code style={{ color: B.accent }}>.md</code> con resumen, calidad de datos, estadísticas, insights y recomendaciones.
                  Compatible con GitHub, Notion, Obsidian y cualquier editor Markdown.
                </div>
                <button
                  onClick={() => {
                    const content = buildMarkdownReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations);
                    downloadFile(content, `datapulse_${fileName.replace(/\.csv$/i, "")}.md`, "text/markdown");
                  }}
                  style={{ background: B.accentSoft, border: `1px solid ${B.accent}`, color: B.accent, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s" }}
                >
                  Descargar .md
                </button>
              </div>

              {/* HTML */}
              <div style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🌐</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: B.textPrimary, marginBottom: 6 }}>Informe HTML</div>
                <div style={{ fontSize: 12, color: B.textMuted, lineHeight: 1.6, flex: 1, marginBottom: 16 }}>
                  Informe visual autocontenido en formato <code style={{ color: B.blue }}>.html</code> con estilo dark theme. Ábrelo en cualquier navegador, compártelo o adjúntalo a un correo.
                </div>
                <button
                  onClick={() => {
                    const content = buildHTMLReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations);
                    downloadFile(content, `datapulse_${fileName.replace(/\.csv$/i, "")}.html`, "text/html");
                  }}
                  style={{ background: "rgba(59,130,246,0.12)", border: `1px solid ${B.blue}`, color: B.blue, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s" }}
                >
                  Descargar .html
                </button>
              </div>

              {/* Clean CSV */}
              <div style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🧹</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: B.textPrimary, marginBottom: 6 }}>CSV Limpio</div>
                <div style={{ fontSize: 12, color: B.textMuted, lineHeight: 1.6, flex: 1, marginBottom: 16 }}>
                  Dataset original sin filas duplicadas en formato <code style={{ color: B.purple }}>.csv</code>. Aplica los filtros activos antes de exportar para obtener solo los datos que necesitas.
                  {quality.duplicates > 0 && <><br /><span style={{ color: B.amber, fontWeight: 600 }}>Se eliminarán {quality.duplicates} duplicados.</span></>}
                </div>
                <button
                  onClick={() => {
                    const content = buildCleanCSV(headers, filteredRows);
                    downloadFile(content, `datapulse_clean_${fileName}`, "text/csv");
                  }}
                  style={{ background: "rgba(139,92,246,0.12)", border: `1px solid ${B.purple}`, color: B.purple, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s" }}
                >
                  Descargar CSV limpio
                </button>
              </div>

            </div>

            <div style={{ marginTop: 24, padding: "12px 16px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, fontSize: 12, color: B.textMuted, lineHeight: 1.6 }}>
              <span style={{ color: B.amber }}>⚠️ Privacidad:</span> Todos los archivos se generan localmente en tu navegador. No se envía ningún dato a servidores externos.
            </div>
          </div>
        )}

      </div>

      {/* ── AI INSIGHTS PANEL (always visible when data loaded) ── */}
      <div style={{ padding: "0 24px 48px" }}>
        <div style={{ borderTop: `1px solid ${B.cardBorder}`, paddingTop: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px", background: `linear-gradient(135deg, #A78BFA, #60A5FA)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                ✨ Insights con IA
              </h2>
              <p style={{ color: B.textMuted, fontSize: 12, margin: 0 }}>
                Gemini analiza el resumen estadístico de tu dataset (no el CSV completo).
              </p>
            </div>
            <button
              disabled={aiLoading}
              onClick={async () => {
                setAiLoading(true);
                setAiError(null);
                setAiInsights(null);
                try {
                  const result = await generateAIInsights(headers, rows, types, statsMap, quality);
                  setAiInsights(result);
                } catch (err) {
                  setAiError(err.message);
                } finally {
                  setAiLoading(false);
                }
              }}
              style={{
                background: aiLoading ? "rgba(167,139,250,0.08)" : "linear-gradient(135deg, rgba(167,139,250,0.2), rgba(96,165,250,0.2))",
                border: "1px solid rgba(167,139,250,0.4)",
                color: aiLoading ? B.textMuted : "#C4B5FD",
                borderRadius: 10, padding: "10px 20px", cursor: aiLoading ? "not-allowed" : "pointer",
                fontSize: 13, fontFamily: "inherit", fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s",
              }}
            >
              {aiLoading
                ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Analizando...</>
                : "✨ Generar insights con IA"}
            </button>
          </div>

          {/* No API key message */}
          {aiError === "NO_API_KEY" && (
            <div style={{ padding: "16px 20px", background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 12, fontSize: 13, lineHeight: 1.8 }}>
              <div style={{ fontWeight: 700, color: "#C4B5FD", marginBottom: 8 }}>🔑 Configura tu API key de Gemini</div>
              <ol style={{ color: B.textSecondary, margin: "0 0 0 16px", padding: 0 }}>
                <li>Obtén una key gratuita en <strong style={{ color: "#A78BFA" }}>aistudio.google.com/app/apikey</strong></li>
                <li>Crea el archivo <code style={{ color: B.accent, background: "rgba(16,185,129,0.1)", padding: "1px 5px", borderRadius: 3 }}>.env</code> en la raíz del proyecto</li>
                <li>Agrega: <code style={{ color: B.accent, background: "rgba(16,185,129,0.1)", padding: "1px 5px", borderRadius: 3 }}>VITE_GEMINI_API_KEY=tu_key_aqui</code></li>
                <li>Reinicia el servidor de desarrollo (<code style={{ color: B.accent }}>npm run dev</code>)</li>
              </ol>
            </div>
          )}

          {/* Quota / auth errors */}
          {aiError && aiError !== "NO_API_KEY" && (
            <div style={{ padding: "14px 18px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 10, fontSize: 13, color: "#FCA5A5" }}>
              {aiError === "QUOTA_EXCEEDED" && "⏱️ Cuota de la API agotada. Espera unos minutos e intenta de nuevo (Gemini free tier: 15 req/min)."}
              {aiError === "API_KEY_INVALID" && "🚫 API key inválida o sin permisos. Verifica tu key en aistudio.google.com/app/apikey"}
              {aiError === "EMPTY_RESPONSE" && "⚠️ Gemini devolvió una respuesta vacía. Intenta de nuevo."}
              {!["QUOTA_EXCEEDED", "API_KEY_INVALID", "EMPTY_RESPONSE"].includes(aiError) && `⚠️ Error: ${aiError}`}
            </div>
          )}

          {/* Loading skeleton */}
          {aiLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[80, 60, 90, 55, 70].map((w, i) => (
                <div key={i} style={{ height: 14, background: `linear-gradient(90deg, ${B.cardBorder} 25%, rgba(167,139,250,0.1) 50%, ${B.cardBorder} 75%)`, borderRadius: 7, width: `${w}%`, backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite" }} />
              ))}
            </div>
          )}

          {/* AI results */}
          {aiInsights && !aiLoading && (
            <div style={{ padding: "18px 20px", background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: "#A78BFA", marginBottom: 12, letterSpacing: "0.08em", fontWeight: 600 }}>GEMINI 2.0 FLASH · ANÁLISIS IA</div>
              <div style={{ fontSize: 13, color: B.textSecondary, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
                {aiInsights}
              </div>
              <div style={{ marginTop: 14, fontSize: 11, color: B.textMuted }}>
                ⚠️ Los insights de IA complementan — no reemplazan — el análisis estadístico. Verifica las conclusiones con tus datos.
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      `}</style>
    </div>
  );
}
