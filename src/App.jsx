import { useState, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { generateAIInsights } from "./services/geminiInsights";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine
} from "recharts";

// ── Utility helpers ───────────────────────────────────────────────
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

function fmtBinLabel(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function computeHistogram(values) {
  const nums = values
    .filter(v => v != null && v !== "" && !isNaN(toNum(v)))
    .map(toNum)
    .filter(isFinite);
  if (nums.length === 0) return [];
  const unique = [...new Set(nums)];
  if (unique.length <= 5) {
    const conteo = {};
    nums.forEach(v => { conteo[v] = (conteo[v] || 0) + 1; });
    return Object.entries(conteo)
      .map(([val, count]) => ({ rango: fmtBinLabel(Number(val)), count }))
      .sort((a, b) => Number(a.rango.replace(/[KM]$/, "")) - Number(b.rango.replace(/[KM]$/, "")));
  }
  let min = nums[0], max = nums[0];
  for (const n of nums) { if (n < min) min = n; if (n > max) max = n; }
  if (min === max) return [{ rango: fmtBinLabel(min), count: nums.length }];
  const numBins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(nums.length))));
  const step = (max - min) / numBins;
  const buckets = Array.from({ length: numBins }, (_, i) => ({ rango: fmtBinLabel(min + i * step), count: 0 }));
  nums.forEach(v => { const i = Math.min(Math.floor((v - min) / step), numBins - 1); buckets[i].count++; });
  return buckets.filter(b => b.count > 0);
}

function computeDataQuality(headers, rows, types, statsMap) {
  let score = 100;
  const rowKeys = rows.map(r => r.join("|"));
  const uniqueKeys = new Set(rowKeys);
  const duplicates = rows.length - uniqueKeys.size;
  const duplicatePct = rows.length > 0 ? duplicates / rows.length : 0;
  if (duplicatePct > 0.05) score -= 15;
  else if (duplicatePct > 0) score -= 5;
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
  const badNames = headers.filter(h => /\s/.test(h) || /[áéíóúÁÉÍÓÚñÑ]/.test(h) || h.length > 30);
  if (badNames.length > 0) score -= Math.min(5, badNames.length * 2);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const badge = score >= 80 ? "Bueno" : score >= 50 ? "Atención" : "Crítico";
  const badgeColor = score >= 80 ? "#22D3A4" : score >= 50 ? "#F5A623" : "#EF4444";
  return { score, badge, badgeColor, duplicates, duplicatePct, nullDetails, badNames, totalNulls };
}

function generateRecommendations(headers, rows, types, statsMap, correlations, quality) {
  const recs = [];
  if (quality.duplicates > 0) {
    recs.push({ priority: "alta", text: `Eliminar ${quality.duplicates} filas duplicadas (${(quality.duplicatePct * 100).toFixed(1)}%) para evitar sesgos.`, action: "Exportar CSV limpio sin duplicados" });
  }
  quality.nullDetails.forEach(({ col, count, pct }) => {
    if (pct > 0.3) recs.push({ priority: "alta", text: `"${col}" tiene ${(pct * 100).toFixed(0)}% de valores vacíos. Considera eliminar la columna o imputar con media/moda.`, action: "Revisar fuente de datos" });
    else if (pct > 0.1) recs.push({ priority: "media", text: `"${col}" tiene ${count} valores nulos (${(pct * 100).toFixed(0)}%). Recomendable imputar antes de modelar.`, action: "Imputar valores" });
  });
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.outliers > 0) {
      const pct = (s.outliers / s.count * 100).toFixed(0);
      recs.push({ priority: "media", text: `"${col}" tiene ${s.outliers} outliers (${pct}%). Verifica si son errores de captura o valores legítimos.`, action: "Revisar outliers en la tab Resumen" });
    }
  });
  if (quality.badNames.length > 0) recs.push({ priority: "baja", text: `Columnas con nombres problemáticos: ${quality.badNames.map(n => `"${n}"`).join(", ")}. Usa nombres cortos sin espacios ni acentos.`, action: "Renombrar columnas en el CSV" });
  const dateCols = headers.filter((_, i) => types[i] === "date");
  if (dateCols.length > 0) recs.push({ priority: "baja", text: `Columnas de fecha detectadas: ${dateCols.map(c => `"${c}"`).join(", ")}. Verifica que el formato sea uniforme (YYYY-MM-DD).`, action: "Validar formato de fechas" });
  if (recs.length === 0) recs.push({ priority: "ok", text: "Dataset en buen estado. No se detectaron problemas críticos.", action: "" });
  return recs;
}

function generateInsights(headers, rows, types, statsMap, correlations) {
  const insights = [];
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.missing > rows.length * 0.1)
      insights.push({ type: "warning", text: `"${col}" tiene ${s.missing} valores vacíos (${(s.missing / rows.length * 100).toFixed(0)}%). Puede afectar el análisis.` });
  });
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.outliers > 0)
      insights.push({ type: "info", text: `"${col}" tiene ${s.outliers} valores atípicos fuera del rango IQR.` });
  });
  correlations.filter(c => Math.abs(c.r) > 0.7).forEach(c => {
    const dir = c.r > 0 ? "positiva" : "negativa";
    insights.push({ type: "success", text: `Correlación ${dir} fuerte (r=${c.r.toFixed(2)}) entre "${c.a}" y "${c.b}".` });
  });
  headers.forEach((h, i) => {
    if (types[i] === "categorical") {
      const counts = {};
      rows.forEach(r => { const v = r[i]; if (v) counts[v] = (counts[v] || 0) + 1; });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1) {
        const pct = (sorted[0][1] / rows.length * 100).toFixed(0);
        insights.push({ type: "info", text: Number(pct) > 50 ? `En "${h}", "${sorted[0][0]}" domina con ${pct}% de los registros.` : `En "${h}", el valor más frecuente es "${sorted[0][0]}" con ${pct}%.` });
      }
    }
  });
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.mean !== 0 && Math.abs(s.std / s.mean) > 1.5)
      insights.push({ type: "info", text: `"${col}" tiene alta variabilidad (CV=${Math.abs(s.std / s.mean).toFixed(1)}x). Los datos están muy dispersos respecto a la media.` });
  });
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.min >= 0 && s.max > 0 && s.mean > 0) {
      const skew = (s.mean - s.median) / (s.std || 1);
      if (skew > 0.5) insights.push({ type: "info", text: `"${col}" muestra asimetría positiva: media (${fmt(s.mean)}) > mediana (${fmt(s.median)}).` });
      else if (skew < -0.5) insights.push({ type: "info", text: `"${col}" muestra asimetría negativa: media (${fmt(s.mean)}) < mediana (${fmt(s.median)}).` });
    }
  });
  if (insights.length === 0) insights.push({ type: "success", text: "Datos limpios y consistentes. No se detectaron problemas evidentes." });
  return insights.slice(0, 10);
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

function buildMarkdownReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations) {
  const now = new Date().toLocaleDateString("es-ES");
  let md = `# Informe DataPulse — ${fileName}\n\n`;
  md += `> Generado el ${now} | ${rows.length.toLocaleString()} filas × ${headers.length} columnas\n\n`;
  md += `## Resumen del Dataset\n\n| Métrica | Valor |\n|---|---|\n`;
  md += `| Filas totales | ${rows.length.toLocaleString()} |\n| Columnas | ${headers.length} |\n`;
  md += `| Columnas numéricas | ${headers.filter((_, i) => types[i] === "numeric").length} |\n`;
  md += `| Columnas categóricas | ${headers.filter((_, i) => types[i] === "categorical").length} |\n`;
  md += `| Columnas de fecha | ${headers.filter((_, i) => types[i] === "date").length} |\n\n`;
  md += `## Calidad de Datos\n\n**Score: ${quality.score}/100 — ${quality.badge}**\n\n`;
  md += `- Filas duplicadas: ${quality.duplicates}\n- Valores nulos totales: ${quality.totalNulls}\n\n`;
  if (quality.nullDetails.length > 0) {
    md += `### Nulos por columna\n\n| Columna | Nulos | % |\n|---|---|---|\n`;
    quality.nullDetails.forEach(({ col, count, pct }) => { md += `| ${col} | ${count} | ${(pct * 100).toFixed(1)}% |\n`; });
    md += "\n";
  }
  md += `## Estadísticas por Columna\n\n`;
  Object.entries(statsMap).forEach(([col, s]) => {
    if (!s) return;
    md += `### ${col}\n\n| Estadístico | Valor |\n|---|---|\n`;
    md += `| Media | ${fmt(s.mean)} |\n| Mediana | ${fmt(s.median)} |\n| Desv. estándar | ${fmt(s.std)} |\n`;
    md += `| Mínimo | ${fmt(s.min)} |\n| Máximo | ${fmt(s.max)} |\n| Outliers | ${s.outliers} |\n\n`;
  });
  md += `## Insights Automáticos\n\n`;
  insights.forEach(ins => { md += `- ${ins.text}\n`; });
  md += `\n## Recomendaciones\n\n`;
  recommendations.forEach(rec => { md += `- **[${rec.priority.toUpperCase()}]** ${rec.text}\n`; });
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
    `<tr><td>${col}</td><td>${count}</td><td>${(pct * 100).toFixed(1)}%</td></tr>`).join("");
  const insightItems = insights.map(ins => `<li>${ins.text}</li>`).join("");
  const recItems = recommendations.map(r => `<li><strong>[${r.priority.toUpperCase()}]</strong> ${r.text}</li>`).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Informe DataPulse — ${fileName}</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#0A0F1E;color:#E2E8F0;padding:40px;max-width:960px;margin:0 auto;line-height:1.6}
h1{color:#00D4FF;margin-bottom:4px}h2{color:#F5A623;border-bottom:1px solid #1A2B4A;padding-bottom:8px;margin-top:32px}
table{border-collapse:collapse;width:100%;margin:16px 0}th{background:#111E35;color:#94A3B8;padding:8px 12px;text-align:left;font-size:13px}
td{padding:8px 12px;border-bottom:1px solid #1A2B4A;font-size:13px}
.badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:14px;background:${bc}22;color:${bc};border:1px solid ${bc}55}
.score{font-size:56px;font-weight:800;color:${bc};line-height:1}.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
.kpi{background:#111E35;border:1px solid #1A2B4A;border-radius:10px;padding:14px}.kpi-label{font-size:11px;color:#475569;margin-bottom:4px}
.kpi-value{font-size:22px;font-weight:700;color:#00D4FF}.footer{color:#334155;font-size:12px;margin-top:40px;border-top:1px solid #1A2B4A;padding-top:16px}
</style></head><body>
<h1>DataPulse — Informe de análisis</h1>
<p style="color:#64748B;font-size:13px">Archivo: <strong>${fileName}</strong> | Generado el ${now}</p>
<h2>Resumen del Dataset</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Filas</div><div class="kpi-value">${rows.length.toLocaleString()}</div></div>
  <div class="kpi"><div class="kpi-label">Columnas</div><div class="kpi-value">${headers.length}</div></div>
  <div class="kpi"><div class="kpi-label">Numéricas</div><div class="kpi-value">${headers.filter((_, i) => types[i] === "numeric").length}</div></div>
  <div class="kpi"><div class="kpi-label">Categóricas</div><div class="kpi-value">${headers.filter((_, i) => types[i] === "categorical").length}</div></div>
</div>
<h2>Calidad de Datos</h2>
<div class="score">${quality.score}<span style="font-size:24px;color:#475569">/100</span></div><br>
<span class="badge">${quality.badge}</span>
<p>Duplicados: <strong>${quality.duplicates}</strong> | Valores nulos totales: <strong>${quality.totalNulls}</strong></p>
${quality.nullDetails.length > 0 ? `<table><tr><th>Columna</th><th>Nulos</th><th>%</th></tr>${nullRows}</table>` : ""}
<h2>Estadísticas por Columna</h2>
${statsRows ? `<table><tr><th>Columna</th><th>Media</th><th>Mediana</th><th>Desv.</th><th>Mín</th><th>Máx</th><th>Outliers</th></tr>${statsRows}</table>` : "<p style='color:#475569'>No hay columnas numéricas.</p>"}
<h2>Insights Automáticos</h2><ul>${insightItems}</ul>
<h2>Recomendaciones</h2><ul>${recItems}</ul>
<p class="footer">Informe generado por DataPulse — Datos procesados localmente en el navegador.</p>
</body></html>`;
}

function buildCleanCSV(headers, rows) {
  const seen = new Set();
  const cleanRows = rows.filter(r => { const key = r.join("|"); if (seen.has(key)) return false; seen.add(key); return true; });
  const esc = v => (v.includes(",") || v.includes('"') || v.includes("\n")) ? `"${v.replace(/"/g, '""')}"` : v;
  return [headers.map(esc).join(","), ...cleanRows.map(r => r.map(esc).join(","))].join("\n");
}

function parseExcelSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (data.length < 2) return { headers: [], rows: [] };
  const headers = data[0].map(h => String(h ?? "").trim());
  const len = headers.length;
  const rows = data.slice(1)
    .filter(r => r.some(v => v !== "" && v != null))
    .map(r => {
      const cells = r.map(v => (v == null ? "" : String(v).trim()));
      while (cells.length < len) cells.push("");
      return cells.slice(0, len);
    });
  return { headers, rows };
}

// ── SVG Icon system ───────────────────────────────────────────────
const IC = {
  chart:    "M3 3v18h18M7 16l4-4 4 4 4-8",
  shield:   "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  search:   "m21 21-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z",
  filter:   "M3 6h18M7 12h10M11 18h2",
  network:  "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18",
  bulb:     "M9 21h6M12 3a6 6 0 0 1 6 6c0 2.22-1.21 4.16-3 5.2V18H9v-3.8C7.21 13.16 6 11.22 6 9a6 6 0 0 1 6-6z",
  table:    "M3 3h18v18H3V3zM3 9h18M9 9v9M3 15h18",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  sparkles: "M12 3l1.5 4.5H18l-3.75 2.7 1.5 4.5L12 12l-3.75 2.7 1.5-4.5L6 7.5h4.5L12 3z",
  upload:   "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  x:        "M18 6L6 18M6 6l12 12",
  file:     "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2zM14 2v6h6",
  rows:     "M3 3h18v4H3V3zM3 9h18v4H3V9zM3 15h18v4H3v-4z",
  hash:     "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  tag:      "M12 2H2v10l9.29 9.29a2 2 0 0 0 2.83 0L22 13.12a2 2 0 0 0 0-2.83L12 2zM7 7h.01",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  alert:    "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  check:    "M20 6L9 17l-5-5",
  copy:     "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 4h8a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  refresh:  "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
};

function Ico({ d, size = 16, color = "currentColor", sw = 1.75 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block" }}>
      <path d={d} />
    </svg>
  );
}

// ── Brand tokens ──────────────────────────────────────────────────
const B = {
  bg:            "#0A0F1E",
  surface:       "#0D1526",
  card:          "#111E35",
  cardBorder:    "#1A2B4A",
  cardHover:     "#1E3158",
  accent:        "#00D4FF",
  accentSoft:    "rgba(0,212,255,0.10)",
  accentGlow:    "rgba(0,212,255,0.20)",
  highlight:     "#F5A623",
  highlightSoft: "rgba(245,166,35,0.12)",
  red:           "#EF4444",
  redSoft:       "rgba(239,68,68,0.12)",
  green:         "#22D3A4",
  greenSoft:     "rgba(34,211,164,0.12)",
  purple:        "#818CF8",
  purpleSoft:    "rgba(129,140,248,0.12)",
  textPrimary:   "#E2E8F0",
  textSecondary: "#94A3B8",
  textMuted:     "#475569",
};

const CHART_COLORS = [B.accent, B.highlight, B.purple, B.green, B.red, "#F472B6", "#06B6D4", "#84CC16"];

const card = {
  background: B.card,
  border: `1px solid ${B.cardBorder}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};

// ── Tooltips ──────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: "inherit", boxShadow: `0 8px 32px rgba(0,0,0,0.5)` }}>
      {label && <p style={{ color: B.textMuted, margin: "0 0 6px" }}>{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || B.accent, margin: "2px 0", fontWeight: 600 }}>
          {p.name}: {typeof p.value === "number" ? fmt(p.value) : p.value}
        </p>
      ))}
    </div>
  );
};

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, fontFamily: "inherit", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
      <p style={{ color: B.accent, margin: "2px 0" }}>X: {fmt(d?.x)}</p>
      <p style={{ color: B.highlight, margin: "2px 0" }}>Y: {fmt(d?.y)}</p>
    </div>
  );
};

// ── Priority Badge ────────────────────────────────────────────────
function PriorityBadge({ priority }) {
  const map = {
    alta:  { bg: B.redSoft,       border: "rgba(239,68,68,0.3)",   color: "#FCA5A5", label: "Alta"  },
    media: { bg: B.highlightSoft, border: "rgba(245,166,35,0.3)",  color: "#FCD34D", label: "Media" },
    baja:  { bg: B.purpleSoft,    border: "rgba(129,140,248,0.3)", color: "#A5B4FC", label: "Baja"  },
    ok:    { bg: B.greenSoft,     border: "rgba(34,211,164,0.3)",  color: "#6EE7B7", label: "OK"    },
  };
  const s = map[priority] || map.baja;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: s.bg, border: `1px solid ${s.border}`, color: s.color, letterSpacing: "0.05em", flexShrink: 0 }}>
      {s.label}
    </span>
  );
}

// ── Section header ────────────────────────────────────────────────
function SectionHeader({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px", color: B.textPrimary }}>{title}</h2>
      {sub && <p style={{ fontSize: 12, color: B.textMuted, margin: 0 }}>{sub}</p>}
    </div>
  );
}

// ── Data Explorer ─────────────────────────────────────────────────
const PAGE_SIZE = 25;

function DataExplorer({ headers, rows }) {
  const [search, setSearch]       = useState("");
  const [filterCol, setFilterCol] = useState("__all__");
  const [filterVal, setFilterVal] = useState("");
  const [sortCol, setSortCol]     = useState(null);
  const [sortDir, setSortDir]     = useState("asc");
  const [page, setPage]           = useState(0);

  const processed = useMemo(() => {
    let result = rows;
    const q = search.trim().toLowerCase();
    if (q) result = result.filter(r => r.some(v => v.toLowerCase().includes(q)));
    const fq = filterVal.trim().toLowerCase();
    if (fq && filterCol !== "__all__") {
      const ci = headers.indexOf(filterCol);
      if (ci !== -1) result = result.filter(r => r[ci].toLowerCase().includes(fq));
    }
    if (sortCol !== null) {
      const ci = headers.indexOf(sortCol);
      result = [...result].sort((a, b) => {
        const av = a[ci], bv = b[ci];
        const an = Number(av.replace(",", ".")), bn = Number(bv.replace(",", "."));
        const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv, "es");
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return result;
  }, [rows, headers, search, filterCol, filterVal, sortCol, sortDir]);

  const totalPages = Math.ceil(processed.length / PAGE_SIZE);
  const pageRows   = processed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const startRow   = processed.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const endRow     = Math.min((page + 1) * PAGE_SIZE, processed.length);

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
    setPage(0);
  }

  function handleSearch(v) { setSearch(v); setPage(0); }
  function handleFilterCol(v) { setFilterCol(v); setFilterVal(""); setPage(0); }
  function handleFilterVal(v) { setFilterVal(v); setPage(0); }

  function exportCSV() {
    const esc = v => (v.includes(",") || v.includes('"') || v.includes("\n")) ? `"${v.replace(/"/g, '""')}"` : v;
    const content = [headers.map(esc).join(","), ...processed.map(r => r.map(esc).join(","))].join("\n");
    downloadFile(content, "datapulse_filtrado.csv", "text/csv");
  }

  const inputBase = {
    background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 8,
    color: B.textPrimary, fontSize: 12, padding: "7px 12px", fontFamily: "inherit", outline: "none",
  };

  return (
    <div style={{ ...card, marginTop: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Ico d={IC.table} size={14} color={B.accent} />
          <span style={{ fontSize: 13, fontWeight: 700, color: B.textPrimary }}>Explorador de datos</span>
        </div>
        <button
          onClick={exportCSV}
          style={{ display: "flex", alignItems: "center", gap: 6, background: B.accentSoft, border: `1px solid ${B.accent}33`, borderRadius: 8, color: B.accent, fontSize: 12, fontWeight: 600, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}
        >
          <Ico d={IC.download} size={13} color={B.accent} />
          Exportar filtrado
        </button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 180px", minWidth: 140 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "flex" }}>
            <Ico d={IC.search} size={13} color={B.textMuted} />
          </span>
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Buscar en todas las columnas…"
            style={{ ...inputBase, width: "100%", paddingLeft: 32, boxSizing: "border-box" }}
          />
        </div>
        <select
          value={filterCol}
          onChange={e => handleFilterCol(e.target.value)}
          style={{ ...inputBase, cursor: "pointer" }}
        >
          <option value="__all__">Todas las columnas</option>
          {headers.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        {filterCol !== "__all__" && (
          <input
            value={filterVal}
            onChange={e => handleFilterVal(e.target.value)}
            placeholder={`Filtrar "${filterCol}"…`}
            style={{ ...inputBase, flex: "1 1 140px", minWidth: 120 }}
          />
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%", minWidth: 400 }}>
          <thead>
            <tr style={{ background: "rgba(26,43,74,0.5)" }}>
              <th style={{ padding: "7px 10px", color: B.textMuted, fontWeight: 600, textAlign: "center", whiteSpace: "nowrap" }}>#</th>
              {headers.map(h => (
                <th
                  key={h}
                  onClick={() => toggleSort(h)}
                  style={{ padding: "7px 10px", color: sortCol === h ? B.accent : B.textMuted, fontWeight: 600, textAlign: "left", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}
                >
                  {h}&nbsp;<span style={{ opacity: sortCol === h ? 1 : 0.35, fontSize: 10 }}>{sortCol === h ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={headers.length + 1} style={{ padding: "24px 10px", textAlign: "center", color: B.textMuted, fontSize: 13 }}>
                  Sin resultados para los filtros actuales.
                </td>
              </tr>
            ) : pageRows.map((r, ri) => (
              <tr key={ri} style={{ borderTop: `1px solid ${B.cardBorder}`, background: ri % 2 === 1 ? "rgba(26,43,74,0.18)" : "transparent" }}>
                <td style={{ padding: "6px 10px", color: B.textMuted, textAlign: "center" }}>{startRow + ri}</td>
                {r.map((v, ci) => (
                  <td key={ci} style={{ padding: "6px 10px", color: B.textSecondary, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer: counter + pagination */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 11, color: B.textMuted }}>
          {processed.length === 0
            ? "Sin resultados"
            : `Mostrando ${startRow}–${endRow} de ${processed.length.toLocaleString()} filas`}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 6, color: B.textSecondary, fontSize: 12, padding: "5px 12px", cursor: page === 0 ? "default" : "pointer", fontFamily: "inherit", opacity: page === 0 ? 0.4 : 1 }}
          >← Ant.</button>
          <span style={{ fontSize: 11, color: B.textMuted, minWidth: 52, textAlign: "center" }}>
            {totalPages === 0 ? "0 / 0" : `${page + 1} / ${totalPages}`}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{ background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 6, color: B.textSecondary, fontSize: 12, padding: "5px 12px", cursor: page >= totalPages - 1 ? "default" : "pointer", fontFamily: "inherit", opacity: page >= totalPages - 1 ? 0.4 : 1 }}
          >Sig. →</button>
        </div>
      </div>
    </div>
  );
}

// ── Data Cleaner ──────────────────────────────────────────────────
function CleanBadge({ msg }) {
  if (!msg) return null;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: B.green, background: B.greenSoft, border: `1px solid rgba(34,211,164,0.3)`, borderRadius: 6, padding: "3px 10px", whiteSpace: "nowrap" }}>
      ✓ {msg}
    </span>
  );
}

function DataCleaner({ originalData, workingData, setWorkingData, cleanOps, setCleanOps, nullStrats, setNullStrats, cleanFeedback, setCleanFeedback }) {
  // Stable copy — only recomputed when workingData or originalData actually changes,
  // not on every render. This prevents blocking the main thread on each re-render.
  const current = useMemo(() =>
    workingData ?? { headers: [...originalData.headers], rows: originalData.rows.map(r => [...r]) },
    [workingData, originalData]
  );

  const dupCount = useMemo(() => {
    const seen = new Set();
    let count = 0;
    for (const r of current.rows) { const key = r.join("|"); if (seen.has(key)) count++; else seen.add(key); }
    return count;
  }, [current.rows]);

  const nullCols = useMemo(() =>
    current.headers.map((h, i) => {
      const count = current.rows.filter(r => !r[i] || r[i].trim() === "").length;
      return count > 0 ? { col: h, idx: i, count } : null;
    }).filter(Boolean),
  [current.rows, current.headers]);

  const normalizedHeaders = useMemo(() =>
    current.headers.map(h =>
      h.toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[\s-]+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .replace(/^_+|_+$/g, "")
        || "col"
    ),
  [current.headers]);

  const headersNeedNorm = normalizedHeaders.some((n, i) => n !== current.headers[i]);

  function flash(id, msg) {
    setCleanFeedback(f => ({ ...f, [id]: msg }));
    setTimeout(() => setCleanFeedback(f => { const n = { ...f }; delete n[id]; return n; }), 4000);
  }

  function removeDuplicates() {
    if (dupCount === 0) return;
    const w = current;
    const seen = new Set();
    const newRows = w.rows.filter(r => { const k = r.join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
    const removed = w.rows.length - newRows.length;
    setWorkingData({ ...w, rows: newRows });
    setCleanOps(o => ({ ...o, dupsRemoved: o.dupsRemoved + removed }));
    flash("dups", `${removed} duplicado${removed !== 1 ? "s" : ""} eliminado${removed !== 1 ? "s" : ""}`);
  }

  function applyNullFill(colName, colIdx) {
    const strategy = nullStrats[colName] || "mean";
    const w = current;
    const nonNull = w.rows.map(r => r[colIdx]).filter(v => v && v.trim() !== "");

    let fillValue = "0";
    if (strategy === "mean") {
      const nums = nonNull.map(toNum).filter(n => !isNaN(n));
      fillValue = nums.length > 0 ? String(+((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4))) : "0";
    } else if (strategy === "median") {
      const nums = [...nonNull.map(toNum).filter(n => !isNaN(n))].sort((a, b) => a - b);
      const m = Math.floor(nums.length / 2);
      fillValue = nums.length > 0 ? String(+(nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2).toFixed(4)) : "0";
    } else if (strategy === "moda") {
      const counts = {};
      nonNull.forEach(v => counts[v] = (counts[v] || 0) + 1);
      fillValue = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    }

    let filled = 0;
    let newRows;
    if (strategy === "drop") {
      const before = w.rows.length;
      newRows = w.rows.filter(r => r[colIdx] && r[colIdx].trim() !== "");
      filled = before - newRows.length;
    } else {
      newRows = w.rows.map(r => {
        if (!r[colIdx] || r[colIdx].trim() === "") { const nr = [...r]; nr[colIdx] = fillValue; filled++; return nr; }
        return r;
      });
    }

    setWorkingData({ ...w, rows: newRows });
    setCleanOps(o => ({ ...o, nullsFilled: o.nullsFilled + filled }));
    const label = { mean: "media", median: "mediana", moda: "moda", zero: "0", drop: "eliminando filas" }[strategy];
    flash(`null_${colName}`, `${filled} nulo${filled !== 1 ? "s" : ""} con ${label}`);
  }

  function normalizeHeaders() {
    if (!headersNeedNorm) return;
    const w = current;
    const changed = normalizedHeaders.filter((n, i) => n !== w.headers[i]).length;
    setWorkingData({ ...w, headers: normalizedHeaders });
    setCleanOps(o => ({ ...o, colsNormalized: o.colsNormalized + changed }));
    flash("headers", `${changed} columna${changed !== 1 ? "s" : ""} normalizada${changed !== 1 ? "s" : ""}`);
  }

  function resetAll() {
    setWorkingData(null);
    setCleanOps({ dupsRemoved: 0, nullsFilled: 0, colsNormalized: 0 });
    setNullStrats({});
    setCleanFeedback({});
  }

  function exportCSV() {
    const w = current;
    const esc = v => (v.includes(",") || v.includes('"') || v.includes("\n")) ? `"${v.replace(/"/g, '""')}"` : v;
    downloadFile([w.headers.map(esc).join(","), ...w.rows.map(r => r.map(esc).join(","))].join("\n"), "datapulse_limpio.csv", "text/csv");
  }

  const totalChanges = cleanOps.dupsRemoved + cleanOps.nullsFilled + cleanOps.colsNormalized;

  const btnP = { display: "flex", alignItems: "center", gap: 6, background: B.accentSoft, border: `1px solid ${B.accent}44`, borderRadius: 8, color: B.accent, fontSize: 12, fontWeight: 600, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" };
  const btnS = { display: "flex", alignItems: "center", gap: 6, background: "transparent", border: `1px solid ${B.cardBorder}`, borderRadius: 8, color: B.textSecondary, fontSize: 12, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" };
  const btnD = { display: "flex", alignItems: "center", gap: 6, background: B.redSoft, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 8, color: "#FCA5A5", fontSize: 12, fontWeight: 600, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit" };
  const sel  = { background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 6, color: B.textPrimary, fontSize: 11, padding: "5px 10px", fontFamily: "inherit", cursor: "pointer" };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Ico d={IC.sparkles} size={14} color={B.highlight} />
          <span style={{ fontSize: 13, fontWeight: 700, color: B.textPrimary }}>Limpieza de datos</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {totalChanges > 0 && (
            <span style={{ fontSize: 11, color: B.textMuted, background: B.surface, border: `1px solid ${B.cardBorder}`, borderRadius: 6, padding: "4px 10px", whiteSpace: "nowrap" }}>
              {[
                cleanOps.dupsRemoved > 0 && `${cleanOps.dupsRemoved} dup. eliminados`,
                cleanOps.nullsFilled > 0 && `${cleanOps.nullsFilled} nulos rellenados`,
                cleanOps.colsNormalized > 0 && `${cleanOps.colsNormalized} col. normalizadas`,
              ].filter(Boolean).join(" · ")}
            </span>
          )}
          <button onClick={exportCSV} style={btnP}>
            <Ico d={IC.download} size={13} color={B.accent} />
            Descargar CSV limpio
          </button>
          {totalChanges > 0 && (
            <button onClick={resetAll} style={btnS}>
              <Ico d={IC.refresh} size={13} color={B.textSecondary} />
              Resetear
            </button>
          )}
        </div>
      </div>

      {/* Card: Duplicates */}
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, color: B.textPrimary, marginBottom: 10 }}>Eliminar duplicados</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <span style={{ fontSize: 11, color: dupCount > 0 ? B.highlight : B.green }}>
            {dupCount > 0 ? `${dupCount} filas duplicadas detectadas` : "Sin duplicados detectados"}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <CleanBadge msg={cleanFeedback["dups"]} />
            <button onClick={removeDuplicates} disabled={dupCount === 0}
              style={{ ...btnD, opacity: dupCount === 0 ? 0.4 : 1, cursor: dupCount === 0 ? "default" : "pointer" }}>
              <Ico d={IC.x} size={13} color="#FCA5A5" />
              {dupCount > 0 ? `Eliminar ${dupCount}` : "Sin duplicados"}
            </button>
          </div>
        </div>
      </div>

      {/* Card: Null filling */}
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, color: B.textPrimary, marginBottom: 12 }}>Relleno de valores nulos</div>
        {nullCols.length === 0 ? (
          <div style={{ fontSize: 11, color: B.green }}>Sin valores nulos en el dataset actual.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {nullCols.map(({ col, idx, count }) => (
              <div key={col} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 14px", background: B.surface, borderRadius: 8, border: `1px solid ${B.cardBorder}` }}>
                <div style={{ flex: "1 1 140px" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: B.textPrimary }}>{col}</span>
                  <span style={{ marginLeft: 8, fontSize: 10, color: B.highlight, background: B.highlightSoft, padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>{count} nulos</span>
                </div>
                <select value={nullStrats[col] || "mean"} onChange={e => setNullStrats(s => ({ ...s, [col]: e.target.value }))} style={sel}>
                  <option value="mean">Rellenar con media</option>
                  <option value="median">Rellenar con mediana</option>
                  <option value="moda">Rellenar con moda</option>
                  <option value="zero">Rellenar con 0</option>
                  <option value="drop">Eliminar filas con nulos</option>
                </select>
                <CleanBadge msg={cleanFeedback[`null_${col}`]} />
                <button onClick={() => applyNullFill(col, idx)} style={{ ...btnP, fontSize: 11, padding: "5px 12px" }}>
                  Aplicar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Card: Normalize headers */}
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, color: B.textPrimary, marginBottom: 10 }}>Normalizar nombres de columnas</div>
        <div style={{ fontSize: 11, color: B.textMuted, marginBottom: 12 }}>
          Convierte a minúsculas, reemplaza espacios por{" "}
          <code style={{ color: B.accent, background: B.accentSoft, padding: "1px 5px", borderRadius: 3 }}>_</code>
          {" "}y elimina caracteres especiales.
        </div>
        {headersNeedNorm ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14, maxHeight: 200, overflowY: "auto" }}>
            {current.headers.map((h, i) => normalizedHeaders[i] !== h ? (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, padding: "6px 12px", background: B.surface, borderRadius: 6, border: `1px solid ${B.cardBorder}` }}>
                <span style={{ color: B.textMuted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                <span style={{ color: B.textMuted, flexShrink: 0 }}>→</span>
                <span style={{ color: B.green, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{normalizedHeaders[i]}</span>
              </div>
            ) : null)}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: B.green, marginBottom: 12 }}>Todos los nombres ya están normalizados.</div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <CleanBadge msg={cleanFeedback["headers"]} />
          <button onClick={normalizeHeaders} disabled={!headersNeedNorm}
            style={{ ...btnP, opacity: !headersNeedNorm ? 0.4 : 1, cursor: !headersNeedNorm ? "default" : "pointer" }}>
            <Ico d={IC.sparkles} size={13} color={B.accent} />
            Normalizar columnas
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function DataPulse() {
  const [data, setData]         = useState(null);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("resumen");

  const [catFilters, setCatFilters] = useState({});
  const [numFilters, setNumFilters] = useState({});
  const [explorerX, setExplorerX]   = useState("");
  const [explorerY, setExplorerY]   = useState("");
  const [explorerType, setExplorerType] = useState("bar");

  const [aiInsights, setAiInsights] = useState(null);
  const [aiLoading, setAiLoading]   = useState(false);
  const [aiError, setAiError]       = useState(null);

  // Excel multi-sheet state
  const [pendingWorkbook, setPendingWorkbook] = useState(null);
  const [sheetNames, setSheetNames]           = useState([]);
  const [activeSheet, setActiveSheet]         = useState("");

  // Data cleaning state (lifted so it survives tab switches)
  const [workingData, setWorkingData]   = useState(null);
  const [cleanOps, setCleanOps]         = useState({ dupsRemoved: 0, nullsFilled: 0, colsNormalized: 0 });
  const [nullStrats, setNullStrats]     = useState({});
  const [cleanFeedback, setCleanFeedback] = useState({});

  const fileRef = useRef();

  const analyzeData = useCallback((parsed) => {
    if (parsed.rows.length === 0) return;
    setData(parsed);
    const types = parsed.headers.map((_, i) => detectType(parsed.rows.map(r => r[i])));
    const statsMap = {};
    parsed.headers.forEach((h, i) => { if (types[i] === "numeric") statsMap[h] = computeStats(parsed.rows.map(r => r[i])); });
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
      if (types[i] === "categorical") initCat[h] = new Set([...new Set(parsed.rows.map(r => r[i]).filter(Boolean))]);
    });
    const initNum = {};
    parsed.headers.forEach((h, i) => {
      if (types[i] === "numeric" && statsMap[h]) initNum[h] = [statsMap[h].min, statsMap[h].max];
    });
    const quality = computeDataQuality(parsed.headers, parsed.rows, types, statsMap);
    const insights = generateInsights(parsed.headers, parsed.rows, types, statsMap, correlations);
    const recommendations = generateRecommendations(parsed.headers, parsed.rows, types, statsMap, correlations, quality);
    setCatFilters(initCat);
    setNumFilters(initNum);
    setExplorerX(numericCols[0] || "");
    setExplorerY(numericCols[1] || numericCols[0] || "");
    setAnalysis({ types, statsMap, correlations, catBreakdowns, insights, quality, recommendations });
    setAiInsights(null); setAiError(null);
    setWorkingData(null); setCleanOps({ dupsRemoved: 0, nullsFilled: 0, colsNormalized: 0 }); setNullStrats({}); setCleanFeedback({});
    setActiveTab("resumen");
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (e) => {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        if (wb.SheetNames.length === 1) {
          analyzeData(parseExcelSheet(wb, wb.SheetNames[0]));
        } else {
          setPendingWorkbook(wb);
          setSheetNames(wb.SheetNames);
          setActiveSheet(wb.SheetNames[0]);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => analyzeData(parseCSV(e.target.result));
      reader.readAsText(file);
    }
  }, [analyzeData]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter(row => {
      for (const [col, allowed] of Object.entries(catFilters)) {
        const idx = data.headers.indexOf(col);
        if (idx >= 0 && allowed.size > 0 && !allowed.has(row[idx])) return false;
      }
      for (const [col, [mn, mx]] of Object.entries(numFilters)) {
        const idx = data.headers.indexOf(col);
        if (idx >= 0) { const v = toNum(row[idx]); if (!isNaN(v) && (v < mn || v > mx)) return false; }
      }
      return true;
    });
  }, [data, catFilters, numFilters]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    setPendingWorkbook(null); setSheetNames([]); setActiveSheet("");
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

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
        if (yIdx >= 0) { const v = toNum(r[yIdx]); if (!isNaN(v)) { counts[k].sum += v; counts[k].n++; } }
      });
      return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 20)
        .map(d => ({ label: d.label, value: yIdx >= 0 && d.n > 0 ? d.sum / d.n : d.count }));
    } else {
      return filteredRows.slice(0, 500).map((r, i) => ({ x: toNum(r[xIdx]), y: yIdx >= 0 ? toNum(r[yIdx]) : i }))
        .filter(d => !isNaN(d.x) && !isNaN(d.y));
    }
  }, [data, analysis, explorerX, explorerY, filteredRows]);

  // ── Upload screen ─────────────────────────────────────────────────
  if (!data && !pendingWorkbook) {
    const features = ["Calidad de datos", "KPIs automáticos", "Histogramas", "Correlaciones", "Insights IA", "Exportar informe"];
    return (
      <div style={{ minHeight: "100vh", background: B.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', monospace", padding: 24, position: "relative", overflow: "hidden" }}>
        {/* Background glows */}
        <div style={{ position: "absolute", top: "20%", left: "30%", width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, rgba(0,212,255,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: "20%", right: "25%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(245,166,35,0.05) 0%, transparent 70%)", pointerEvents: "none" }} />

        <div style={{ textAlign: "center", maxWidth: 520, width: "100%", position: "relative", zIndex: 1 }}>
          {/* Logo mark */}
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 16, background: B.accentSoft, border: `1px solid ${B.accent}`, marginBottom: 20, boxShadow: `0 0 32px ${B.accentGlow}` }}>
            <Ico d={IC.chart} size={24} color={B.accent} sw={2} />
          </div>

          {/* Brand */}
          <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.04em", margin: "0 0 6px", background: `linear-gradient(135deg, ${B.accent} 0%, ${B.purple} 100%)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            DataPulse
          </h1>
          <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 6px", letterSpacing: "0.12em", textTransform: "uppercase" }}>by ErnestoLab</p>
          <p style={{ color: B.textSecondary, fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>
            Analista automático de CSV y Excel para PYMEs · 100% local · sin servidor
          </p>

          {/* Feature pills */}
          <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
            {features.map(f => (
              <span key={f} style={{ fontSize: 11, color: B.accent, background: B.accentSoft, border: `1px solid rgba(0,212,255,0.25)`, borderRadius: 20, padding: "4px 12px", fontWeight: 500 }}>{f}</span>
            ))}
          </div>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? B.accent : B.cardBorder}`,
              borderRadius: 16, padding: "48px 32px", cursor: "pointer",
              background: dragOver ? B.accentSoft : `rgba(13,21,38,0.6)`,
              transition: "all 0.2s",
              boxShadow: dragOver ? `0 0 32px ${B.accentGlow}` : "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: dragOver ? B.accentSoft : "rgba(255,255,255,0.04)", border: `1px solid ${dragOver ? B.accent : B.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }}>
                <Ico d={IC.upload} size={20} color={dragOver ? B.accent : B.textMuted} />
              </div>
            </div>
            <p style={{ color: B.textPrimary, fontSize: 15, margin: "0 0 6px", fontWeight: 600 }}>
              {dragOver ? "Suelta el archivo aquí" : "Arrastra tu CSV o Excel aquí"}
            </p>
            <p style={{ color: B.textMuted, fontSize: 13, margin: 0 }}>o haz clic para seleccionar archivo (.csv, .xlsx, .xls)</p>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" style={{ display: "none" }} onChange={(e) => { setPendingWorkbook(null); handleFile(e.target.files[0]); }} />
          </div>

          {/* Privacy notice */}
          <div style={{ marginTop: 16, padding: "12px 16px", background: B.highlightSoft, border: `1px solid rgba(245,166,35,0.2)`, borderRadius: 10, fontSize: 12, color: B.textMuted, lineHeight: 1.6, textAlign: "left" }}>
            <span style={{ color: B.highlight, fontWeight: 600 }}>Aviso de privacidad:</span> Los datos se procesan{" "}
            <strong style={{ color: B.textSecondary }}>exclusivamente en tu navegador</strong> y nunca se envían a servidores externos.
          </div>
        </div>
      </div>
    );
  }

  // ── Sheet selector (Excel multi-hoja) ────────────────────────────
  if (pendingWorkbook && sheetNames.length > 1) {
    return (
      <div style={{ minHeight: "100vh", background: B.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', monospace", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: B.accentSoft, border: `1px solid rgba(0,212,255,0.35)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Ico d={IC.table} size={14} color={B.accent} sw={2} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 800, background: `linear-gradient(135deg, ${B.accent}, ${B.purple})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>DataPulse</span>
          </div>

          <div style={{ ...card, marginBottom: 0 }}>
            <div style={{ fontSize: 10, color: B.textMuted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Archivo Excel</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
              <Ico d={IC.file} size={13} color={B.textMuted} />
              <span style={{ fontSize: 13, color: B.textPrimary, fontWeight: 600 }}>{fileName}</span>
            </div>

            <div style={{ fontSize: 14, fontWeight: 700, color: B.textPrimary, marginBottom: 4 }}>Selecciona una hoja</div>
            <p style={{ fontSize: 12, color: B.textMuted, margin: "0 0 16px" }}>
              El archivo contiene {sheetNames.length} hojas. Elige cuál analizar.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {sheetNames.map((name, i) => {
                const isActive = activeSheet === name;
                return (
                  <button key={name} onClick={() => setActiveSheet(name)} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8,
                    border: `1px solid ${isActive ? B.accent : B.cardBorder}`,
                    background: isActive ? B.accentSoft : "transparent",
                    color: isActive ? B.accent : B.textSecondary,
                    cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: isActive ? 600 : 400,
                    textAlign: "left", transition: "all 0.15s",
                  }}>
                    <Ico d={IC.table} size={14} color={isActive ? B.accent : B.textMuted} />
                    <span style={{ flex: 1 }}>{name}</span>
                    {isActive && <Ico d={IC.check} size={14} color={B.accent} />}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setPendingWorkbook(null); setSheetNames([]); setActiveSheet(""); setFileName(""); }}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${B.cardBorder}`, background: "transparent", color: B.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const parsed = parseExcelSheet(pendingWorkbook, activeSheet);
                  setPendingWorkbook(null); setSheetNames([]); setActiveSheet("");
                  analyzeData(parsed);
                }}
                style={{ flex: 2, padding: "10px", borderRadius: 8, border: `1px solid ${B.accent}`, background: B.accentSoft, color: B.accent, cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              >
                <Ico d={IC.chart} size={14} color={B.accent} />
                Analizar "{activeSheet}"
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────
  const { headers, rows } = data;
  const { types, statsMap, correlations, insights, quality, recommendations } = analysis;
  const numericCols = headers.filter((_, i) => types[i] === "numeric");
  const catCols     = headers.filter((_, i) => types[i] === "categorical");
  const dateCols    = headers.filter((_, i) => types[i] === "date");

  const activeFiltersCount = Object.entries(catFilters).reduce((acc, [col, s]) => {
    const allVals = [...new Set(rows.map(r => r[headers.indexOf(col)]).filter(Boolean))];
    return acc + (s.size < allVals.length ? 1 : 0);
  }, 0) + Object.entries(numFilters).reduce((acc, [col, [mn, mx]]) => {
    const s = statsMap[col];
    return acc + (s && (mn > s.min || mx < s.max) ? 1 : 0);
  }, 0);

  const navItems = [
    { id: "resumen",      label: "Resumen",      icon: IC.chart   },
    { id: "calidad",      label: "Calidad",       icon: IC.shield  },
    { id: "explorador",   label: "Explorador",    icon: IC.search  },
    { id: "filtros",      label: "Filtros",       icon: IC.filter, badge: activeFiltersCount || 0 },
    { id: "correlaciones",label: "Correlaciones", icon: IC.network },
    { id: "insights",     label: "Insights",      icon: IC.bulb    },
    { id: "datos",        label: "Datos",         icon: IC.table   },
    { id: "exportar",     label: "Exportar",      icon: IC.download},
  ];

  const kpiItems = [
    { label: "Filas (filtradas)", value: `${filteredRows.length.toLocaleString()} / ${rows.length.toLocaleString()}`, icon: IC.rows,     color: B.accent    },
    { label: "Columnas",          value: headers.length,      icon: IC.hash,     color: B.purple    },
    { label: "Numéricas",         value: numericCols.length,  icon: IC.chart,    color: B.accent    },
    { label: "Categóricas",       value: catCols.length,      icon: IC.tag,      color: B.highlight },
    { label: "Fechas",            value: dateCols.length,     icon: IC.calendar, color: B.purple    },
    { label: "Duplicados",        value: quality.duplicates,  icon: IC.copy,     color: quality.duplicates > 0 ? B.red : B.green },
    { label: "Nulos totales",     value: quality.totalNulls,  icon: IC.alert,    color: quality.totalNulls  > 0 ? B.highlight : B.green },
  ];

  const typeColors = { numeric: B.purple, categorical: B.highlight, date: B.accent, text: B.textSecondary, empty: B.red };

  const selStyle = {
    background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary,
    borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
  };

  return (
    <div style={{ minHeight: "100vh", background: B.bg, display: "flex", fontFamily: "'JetBrains Mono', monospace", color: B.textPrimary }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 220, flexShrink: 0, background: B.surface, borderRight: `1px solid ${B.cardBorder}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", overflowY: "auto" }}>

        {/* Brand */}
        <div style={{ padding: "18px 16px 14px", borderBottom: `1px solid ${B.cardBorder}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: B.accentSoft, border: `1px solid rgba(0,212,255,0.35)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Ico d={IC.chart} size={14} color={B.accent} sw={2} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${B.accent}, ${B.purple})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              DataPulse
            </span>
          </div>
        </div>

        {/* File info */}
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${B.cardBorder}` }}>
          <div style={{ fontSize: 9, color: B.textMuted, letterSpacing: "0.1em", marginBottom: 5, textTransform: "uppercase" }}>Archivo activo</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <Ico d={IC.file} size={12} color={B.textMuted} />
            <span style={{ fontSize: 11, color: B.textPrimary, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{ fontSize: 10, color: B.accent, background: B.accentSoft, borderRadius: 4, padding: "2px 7px" }}>{rows.length.toLocaleString()} filas</span>
            <span style={{ fontSize: 10, color: B.textMuted, background: "rgba(255,255,255,0.05)", borderRadius: 4, padding: "2px 7px" }}>{headers.length} cols</span>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {navItems.map(t => {
            const active = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 10px",
                borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                background: active ? B.accentSoft : "transparent",
                color: active ? B.accent : B.textMuted,
                fontWeight: active ? 600 : 400,
                transition: "all 0.15s",
                borderLeft: active ? `2px solid ${B.accent}` : "2px solid transparent",
                textAlign: "left",
              }}>
                <Ico d={t.icon} size={14} color={active ? B.accent : B.textMuted} />
                <span style={{ flex: 1 }}>{t.label}</span>
                {t.badge > 0 && (
                  <span style={{ fontSize: 10, color: B.highlight, background: B.highlightSoft, borderRadius: 10, padding: "1px 6px", fontWeight: 700 }}>
                    {t.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Bottom */}
        <div style={{ padding: "10px 8px 16px", borderTop: `1px solid ${B.cardBorder}`, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Quality score */}
          <div style={{ padding: "10px 12px", background: B.card, borderRadius: 8, border: `1px solid ${B.cardBorder}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 9, color: B.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Calidad</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: quality.badgeColor }}>{quality.score}/100</span>
            </div>
            <div style={{ height: 4, background: B.cardBorder, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${quality.score}%`, background: quality.badgeColor, borderRadius: 2, transition: "width 0.5s" }} />
            </div>
            <div style={{ marginTop: 5, fontSize: 10, color: quality.badgeColor, fontWeight: 600 }}>{quality.badge}</div>
          </div>

          {/* Filters active */}
          {activeFiltersCount > 0 && (
            <div style={{ padding: "7px 10px", background: B.highlightSoft, border: `1px solid rgba(245,166,35,0.25)`, borderRadius: 8, fontSize: 10, color: B.highlight }}>
              {activeFiltersCount} filtro{activeFiltersCount > 1 ? "s" : ""} activo{activeFiltersCount > 1 ? "s" : ""} · {filteredRows.length.toLocaleString()} filas
            </div>
          )}

          <button
            onClick={() => { setData(null); setAnalysis(null); setFileName(""); setCatFilters({}); setNumFilters({}); setAiInsights(null); setPendingWorkbook(null); setSheetNames([]); setActiveSheet(""); setWorkingData(null); setCleanOps({ dupsRemoved: 0, nullsFilled: 0, colsNormalized: 0 }); setNullStrats({}); setCleanFeedback({}); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 12px", borderRadius: 8, border: `1px solid ${B.cardBorder}`, background: "transparent", color: B.textMuted, cursor: "pointer", fontSize: 11, fontFamily: "inherit", transition: "all 0.15s" }}
          >
            <Ico d={IC.upload} size={12} color={B.textMuted} />
            Nuevo archivo
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

        {/* KPI strip */}
        <div style={{ padding: "12px 20px", borderBottom: `1px solid ${B.cardBorder}`, display: "flex", gap: 10, overflowX: "auto", flexShrink: 0, background: B.surface }}>
          {kpiItems.map((kpi, i) => (
            <div key={i} style={{ flexShrink: 0, background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 10, padding: "10px 14px", borderLeft: `3px solid ${kpi.color}`, minWidth: 115 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <Ico d={kpi.icon} size={10} color={B.textMuted} />
                <span style={{ fontSize: 9, color: B.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{kpi.label}</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: kpi.color, lineHeight: 1 }}>{kpi.value}</div>
            </div>
          ))}
        </div>

        {/* Content area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px" }} className="dp-card">

          {/* ══ RESUMEN ══ */}
          {activeTab === "resumen" && (
            <div>
              <SectionHeader title="Resumen del dataset" sub="Vista general de columnas, tipos y distribuciones." />

              {/* Column overview */}
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <Ico d={IC.table} size={14} color={B.textMuted} />
                  Estructura de columnas
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "rgba(26,43,74,0.4)" }}>
                        {["Columna", "Tipo", "Únicos", "Nulos", "Muestra"].map(h => (
                          <th key={h} style={{ padding: "7px 10px", color: B.textMuted, textAlign: "left", whiteSpace: "nowrap", fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {headers.map((h, i) => {
                        const colVals = rows.map(r => r[i]);
                        const nulls   = colVals.filter(v => !v || v.trim() === "").length;
                        const uniques = new Set(colVals.filter(Boolean)).size;
                        const sample  = colVals.find(v => v && v.trim() !== "") || "—";
                        const tc = typeColors[types[i]] || B.textMuted;
                        return (
                          <tr key={h} style={{ borderTop: `1px solid ${B.cardBorder}` }}>
                            <td style={{ padding: "7px 10px", color: B.textPrimary, fontWeight: 600 }}>{h}</td>
                            <td style={{ padding: "7px 10px" }}>
                              <span style={{ fontSize: 10, color: tc, background: `${tc}18`, padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>{types[i]}</span>
                            </td>
                            <td style={{ padding: "7px 10px", color: B.textSecondary }}>{uniques.toLocaleString()}</td>
                            <td style={{ padding: "7px 10px", color: nulls > 0 ? B.highlight : B.textMuted }}>{nulls > 0 ? nulls : "—"}</td>
                            <td style={{ padding: "7px 10px", color: B.textMuted, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sample}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* First rows */}
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <Ico d={IC.rows} size={14} color={B.textMuted} />
                  Primeras filas
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
                    <thead>
                      <tr style={{ background: "rgba(26,43,74,0.4)" }}>
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

              {/* Data Explorer */}
              <DataExplorer headers={headers} rows={filteredRows} />

              {/* Data Cleaner */}
              <DataCleaner
                originalData={data}
                workingData={workingData}
                setWorkingData={setWorkingData}
                cleanOps={cleanOps}
                setCleanOps={setCleanOps}
                nullStrats={nullStrats}
                setNullStrats={setNullStrats}
                cleanFeedback={cleanFeedback}
                setCleanFeedback={setCleanFeedback}
              />

              {/* Numeric columns */}
              {numericCols.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                    <Ico d={IC.hash} size={14} color={B.purple} />
                    <span style={{ color: B.purple }}>Columnas numéricas</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
                    {numericCols.map(col => {
                      const s = statsMap[col];
                      const idx = headers.indexOf(col);
                      const lineData = filteredRows.slice(0, 80).map((r, i) => ({ i, v: toNum(r[idx]) })).filter(d => !isNaN(d.v));
                      const histData = computeHistogram(filteredRows.map(r => r[idx]));
                      return (
                        <div key={col} style={card}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: B.purple }}>{col}</span>
                            <span style={{ fontSize: 10, color: B.purple, background: B.purpleSoft, padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>numérica</span>
                          </div>
                          <ResponsiveContainer width="100%" height={60}>
                            <LineChart data={lineData}>
                              <Line type="monotone" dataKey="v" stroke={B.accent} strokeWidth={2} dot={false} />
                              <ReferenceLine y={s?.mean} stroke={B.highlight} strokeDasharray="3 3" strokeOpacity={0.7} />
                              <Tooltip content={<CustomTooltip />} />
                            </LineChart>
                          </ResponsiveContainer>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, margin: "12px 0 10px" }}>
                            {[["Media", fmt(s?.mean), B.accent], ["Mediana", fmt(s?.median), B.textSecondary], ["Desv.", fmt(s?.std), B.textMuted],
                              ["Mín", fmt(s?.min), B.green], ["Máx", fmt(s?.max), B.highlight], ["Outliers", s?.outliers ?? "—", s?.outliers > 0 ? B.red : B.textMuted]
                            ].map(([l, v, c], i) => (
                              <div key={i} style={{ padding: "6px 8px", background: "rgba(26,43,74,0.3)", borderRadius: 6 }}>
                                <div style={{ fontSize: 9, color: B.textMuted, marginBottom: 2 }}>{l}</div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ borderTop: `1px solid ${B.cardBorder}`, paddingTop: 10 }}>
                            <div style={{ fontSize: 9, color: B.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Distribución</div>
                            <ResponsiveContainer width="100%" height={80}>
                              <BarChart data={histData} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
                                <XAxis dataKey="rango" tick={{ fill: B.textMuted, fontSize: 9 }} interval="preserveStartEnd" />
                                <YAxis tick={{ fill: B.textMuted, fontSize: 9 }} />
                                <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,212,255,0.05)" }} />
                                <Bar dataKey="count" fill={B.purple} radius={[2, 2, 0, 0]} fillOpacity={0.85} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                          {s?.outliers > 0 && (
                            <div style={{ marginTop: 8, fontSize: 11, color: B.highlight, background: B.highlightSoft, border: `1px solid rgba(245,166,35,0.25)`, borderRadius: 6, padding: "6px 10px" }}>
                              {s.outliers} outlier{s.outliers > 1 ? "s" : ""} detectado{s.outliers > 1 ? "s" : ""} (IQR: {fmt(s.q1)} — {fmt(s.q3)})
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
                  <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                    <Ico d={IC.tag} size={14} color={B.highlight} />
                    <span style={{ color: B.highlight }}>Columnas categóricas</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
                    {catCols.map(col => {
                      const idx = headers.indexOf(col);
                      const counts = {};
                      filteredRows.forEach(r => { const v = r[idx]; if (v) counts[v] = (counts[v] || 0) + 1; });
                      const chartData = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }));
                      const total = chartData.reduce((a, d) => a + d.value, 0);
                      return (
                        <div key={col} style={card}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: B.highlight }}>{col}</span>
                            <span style={{ fontSize: 10, color: B.highlight, background: B.highlightSoft, padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>{Object.keys(counts).length} únicos</span>
                          </div>
                          <ResponsiveContainer width="100%" height={160}>
                            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 30 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                              <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                              <YAxis tick={{ fill: B.textMuted, fontSize: 10 }} />
                              <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                                {chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                          <div style={{ marginTop: 8, fontSize: 11, color: B.textMuted }}>
                            Top: <span style={{ color: B.highlight, fontWeight: 600 }}>{chartData[0]?.label}</span>{" "}
                            ({chartData[0] ? (chartData[0].value / total * 100).toFixed(0) : 0}%)
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ CALIDAD ══ */}
          {activeTab === "calidad" && (
            <div>
              <SectionHeader title="Calidad del dataset" sub="Análisis automático de duplicados, nulos y problemas de nomenclatura." />

              {/* Score + summary */}
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 16, marginBottom: 16 }}>
                <div style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "28px 36px", minWidth: 160 }}>
                  <div style={{ fontSize: 60, fontWeight: 800, color: quality.badgeColor, lineHeight: 1, textShadow: `0 0 32px ${quality.badgeColor}44` }}>{quality.score}</div>
                  <div style={{ fontSize: 14, color: B.textMuted, marginBottom: 10 }}>/100</div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: quality.badgeColor, background: `${quality.badgeColor}18`, border: `1px solid ${quality.badgeColor}44`, borderRadius: 20, padding: "4px 16px" }}>{quality.badge}</span>
                </div>
                <div style={{ ...card, marginBottom: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>Resumen de problemas</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {[
                      { label: "Filas duplicadas",    value: quality.duplicates,      total: rows.length,                      color: quality.duplicates > 0 ? B.red : B.green },
                      { label: "Valores nulos",        value: quality.totalNulls,       total: rows.length * headers.length,    color: quality.totalNulls > 0 ? B.highlight : B.green },
                      { label: "Columnas con nulos",   value: quality.nullDetails.length, total: headers.length,               color: quality.nullDetails.length > 0 ? B.highlight : B.green },
                      { label: "Nombres problemáticos",value: quality.badNames.length,  total: headers.length,                 color: quality.badNames.length > 0 ? B.accent : B.green },
                    ].map((item, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 150, fontSize: 11, color: B.textMuted, flexShrink: 0 }}>{item.label}</div>
                        <div style={{ flex: 1, height: 5, background: B.cardBorder, borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.min(100, item.value / item.total * 100)}%`, background: item.color, borderRadius: 3, transition: "width 0.5s" }} />
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: item.color, minWidth: 28, textAlign: "right" }}>{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Null analysis */}
              {quality.nullDetails.length > 0 && (
                <div style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>Valores nulos por columna</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {quality.nullDetails.map(({ col, count, pct }) => {
                      const color = pct > 0.3 ? B.red : pct > 0.1 ? B.highlight : B.accent;
                      return (
                        <div key={col} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 140, fontSize: 11, color: B.textPrimary, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{col}</div>
                          <div style={{ flex: 1, height: 6, background: B.cardBorder, borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 3 }} />
                          </div>
                          <div style={{ fontSize: 11, color, fontWeight: 600, minWidth: 72, textAlign: "right" }}>{count} ({(pct * 100).toFixed(1)}%)</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Duplicates */}
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 10 }}>Filas duplicadas</div>
                {quality.duplicates === 0
                  ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: B.green, fontSize: 13 }}><Ico d={IC.check} size={16} color={B.green} /> No se detectaron filas duplicadas.</div>
                  : <p style={{ color: B.red, fontSize: 13, margin: 0 }}>Se detectaron <strong>{quality.duplicates}</strong> filas duplicadas ({(quality.duplicatePct * 100).toFixed(1)}%). Usa Exportar → CSV limpio para eliminarlas.</p>
                }
              </div>

              {/* Bad column names */}
              {quality.badNames.length > 0 && (
                <div style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 10 }}>Nombres de columna problemáticos</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    {quality.badNames.map(n => (
                      <span key={n} style={{ fontSize: 12, color: B.accent, background: B.accentSoft, border: `1px solid rgba(0,212,255,0.25)`, borderRadius: 6, padding: "4px 10px" }}>{n}</span>
                    ))}
                  </div>
                  <p style={{ color: B.textMuted, fontSize: 11, margin: 0 }}>Recomendación: usa nombres cortos en minúsculas sin espacios ni acentos.</p>
                </div>
              )}

              {/* Recommendations */}
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.textSecondary, marginBottom: 14 }}>Recomendaciones accionables</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {recommendations.map((rec, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", background: "rgba(26,43,74,0.3)", borderRadius: 8, border: `1px solid ${B.cardBorder}` }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: B.textPrimary, lineHeight: 1.6 }}>{rec.text}</div>
                        {rec.action && <div style={{ fontSize: 11, color: B.textMuted, marginTop: 4 }}>→ {rec.action}</div>}
                      </div>
                      <PriorityBadge priority={rec.priority} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ EXPLORADOR ══ */}
          {activeTab === "explorador" && (
            <div>
              <SectionHeader title="Explorador de variables" sub="Cruza variables y visualízalas. Los filtros activos se aplican aquí también." />
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                {[
                  { label: "Eje X / Variable principal", val: explorerX, onChange: e => setExplorerX(e.target.value), options: headers.map(h => ({ v: h, l: h })) },
                  { label: "Eje Y / Métrica", val: explorerY, onChange: e => setExplorerY(e.target.value), options: [{ v: "", l: "— conteo —" }, ...numericCols.map(h => ({ v: h, l: h }))] },
                  { label: "Tipo de gráfica", val: explorerType, onChange: e => setExplorerType(e.target.value), options: [{ v: "bar", l: "Barras" }, { v: "line", l: "Líneas" }, { v: "scatter", l: "Dispersión" }] },
                ].map(({ label, val, onChange, options }) => (
                  <div key={label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={{ fontSize: 10, color: B.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</label>
                    <select value={val} onChange={onChange} style={selStyle}>
                      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ ...card, padding: 24 }}>
                <div style={{ marginBottom: 14, fontSize: 13, color: B.textSecondary }}>
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
                      Selecciona una columna numérica en Eje X para el gráfico de dispersión.
                    </div>
                  )
                ) : explorerType === "line" ? (
                  <ResponsiveContainer width="100%" height={360}>
                    <LineChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                      <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval="preserveStartEnd" />
                      <YAxis tick={{ fill: B.textMuted, fontSize: 11 }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="value" stroke={B.accent} strokeWidth={2} dot={{ fill: B.accent, r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={360}>
                    <BarChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                      <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                      <YAxis tick={{ fill: B.textMuted, fontSize: 11 }} />
                      <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,212,255,0.04)" }} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {explorerData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          )}

          {/* ══ FILTROS ══ */}
          {activeTab === "filtros" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                <SectionHeader title="Filtros" sub={`Mostrando ${filteredRows.length.toLocaleString()} de ${rows.length.toLocaleString()} filas`} />
                <button onClick={() => {
                  const initCat = {};
                  headers.forEach((h, i) => { if (types[i] === "categorical") initCat[h] = new Set([...new Set(rows.map(r => r[i]).filter(Boolean))]); });
                  const initNum = {};
                  headers.forEach((h, i) => { if (types[i] === "numeric" && statsMap[h]) initNum[h] = [statsMap[h].min, statsMap[h].max]; });
                  setCatFilters(initCat); setNumFilters(initNum);
                }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", background: B.redSoft, border: `1px solid rgba(239,68,68,0.25)`, color: "#FCA5A5", borderRadius: 8, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                  <Ico d={IC.refresh} size={12} color="#FCA5A5" />
                  Resetear
                </button>
              </div>

              {catCols.map(col => {
                const idx = headers.indexOf(col);
                const allVals = [...new Set(rows.map(r => r[idx]).filter(Boolean))].sort();
                const selected = catFilters[col] || new Set(allVals);
                return (
                  <div key={col} style={card}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: B.highlight, display: "flex", alignItems: "center", gap: 6 }}>
                        <Ico d={IC.tag} size={13} color={B.highlight} />{col}
                      </span>
                      <div style={{ display: "flex", gap: 10 }}>
                        <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set(allVals) }))} style={{ fontSize: 11, color: B.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Todo</button>
                        <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set() }))} style={{ fontSize: 11, color: B.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Ninguno</button>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {allVals.map(val => {
                        const active = selected.has(val);
                        return (
                          <button key={val} onClick={() => setCatFilters(p => {
                            const next = new Set(p[col] || allVals);
                            active ? next.delete(val) : next.add(val);
                            return { ...p, [col]: next };
                          })} style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, cursor: "pointer", fontFamily: "inherit", border: `1px solid ${active ? B.highlight : B.cardBorder}`, background: active ? B.highlightSoft : "transparent", color: active ? B.highlight : B.textMuted, transition: "all 0.15s" }}>
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
                      <span style={{ fontSize: 13, fontWeight: 600, color: B.accent, display: "flex", alignItems: "center", gap: 6 }}>
                        <Ico d={IC.hash} size={13} color={B.accent} />{col}
                      </span>
                      <span style={{ fontSize: 11, color: B.textMuted }}>{fmt(mn)} — {fmt(mx)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 16 }}>
                      {[["Mínimo", s.min, s.max, mn, v => setNumFilters(p => ({ ...p, [col]: [parseFloat(v), mx] }))],
                        ["Máximo", s.min, s.max, mx, v => setNumFilters(p => ({ ...p, [col]: [mn, parseFloat(v)] }))]
                      ].map(([label, min, max, val, onChange]) => (
                        <div key={label} style={{ flex: 1 }}>
                          <label style={{ fontSize: 10, color: B.textMuted, display: "block", marginBottom: 4 }}>{label}</label>
                          <input type="range" min={min} max={max} step={(max - min) / 100} value={val} onChange={e => onChange(e.target.value)} style={{ width: "100%" }} />
                        </div>
                      ))}
                    </div>
                    <span style={{ fontSize: 10, color: B.textMuted }}>Rango original: {fmt(s.min)} — {fmt(s.max)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ══ CORRELACIONES ══ */}
          {activeTab === "correlaciones" && (
            <div>
              <SectionHeader title="Matriz de correlaciones" sub="Valores entre -1 (inversa perfecta) y +1 (directa perfecta)." />
              {numericCols.length < 2 ? (
                <div style={card}><p style={{ color: B.textMuted, fontSize: 13, margin: 0 }}>Se necesitan al menos 2 columnas numéricas para calcular correlaciones.</p></div>
              ) : (
                <div style={{ ...card, overflowX: "auto" }}>
                  <div style={{ fontSize: 11, color: B.textMuted, marginBottom: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <span style={{ color: B.accent }}>■ Positiva fuerte</span>
                    <span style={{ color: B.red }}>■ Negativa fuerte</span>
                    <span style={{ color: B.highlight }}>■ Moderada</span>
                    <span style={{ color: B.textMuted }}>□ Débil</span>
                  </div>
                  <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ padding: 8 }}></th>
                        {numericCols.map(c => <th key={c} style={{ padding: 8, color: B.textMuted, fontWeight: 600, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {numericCols.map(a => (
                        <tr key={a}>
                          <td style={{ padding: "8px 12px", fontWeight: 600, color: B.textSecondary, whiteSpace: "nowrap" }}>{a}</td>
                          {numericCols.map(b => {
                            if (a === b) return <td key={b} style={{ padding: 8, textAlign: "center", color: B.accent, fontWeight: 700 }}>1.00</td>;
                            const c = correlations.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
                            const r = c ? c.r : null;
                            const abs = r != null ? Math.abs(r) : 0;
                            const bg = abs > 0.7 ? (r > 0 ? "rgba(0,212,255,0.18)" : "rgba(239,68,68,0.18)") : abs > 0.4 ? "rgba(245,166,35,0.12)" : "transparent";
                            const color = abs > 0.7 ? (r > 0 ? B.accent : B.red) : abs > 0.4 ? B.highlight : B.textSecondary;
                            return (
                              <td key={b} style={{ padding: 8, textAlign: "center", background: bg, borderRadius: 4, color, fontWeight: abs > 0.7 ? 700 : 400 }}>
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

          {/* ══ INSIGHTS ══ */}
          {activeTab === "insights" && (
            <div>
              <SectionHeader title="Insights automáticos" sub="Hallazgos detectados mediante análisis estadístico de tu dataset." />
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
                {insights.map((ins, i) => {
                  const styles = {
                    warning: { bg: B.highlightSoft, border: "rgba(245,166,35,0.3)", color: B.highlight },
                    info:    { bg: B.accentSoft,    border: "rgba(0,212,255,0.25)",  color: B.accent    },
                    success: { bg: B.greenSoft,     border: "rgba(34,211,164,0.3)",  color: B.green     },
                  };
                  const s = styles[ins.type] || styles.info;
                  return (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "14px 16px", background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10 }}>
                      <Ico d={ins.type === "warning" ? IC.alert : ins.type === "success" ? IC.check : IC.bulb} size={16} color={s.color} />
                      <span style={{ fontSize: 13, color: B.textPrimary, lineHeight: 1.6, flex: 1 }}>{ins.text}</span>
                    </div>
                  );
                })}
              </div>

              <SectionHeader title="Recomendaciones accionables" sub="Acciones sugeridas para mejorar la calidad del dataset." />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recommendations.map((rec, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", background: B.card, border: `1px solid ${B.cardBorder}`, borderRadius: 10 }}>
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

          {/* ══ DATOS ══ */}
          {activeTab === "datos" && (
            <div>
              <SectionHeader title="Vista de datos" sub={`Mostrando ${Math.min(100, filteredRows.length)} de ${filteredRows.length.toLocaleString()} filas filtradas.`} />
              <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${B.cardBorder}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "rgba(26,43,74,0.5)" }}>
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

          {/* ══ EXPORTAR ══ */}
          {activeTab === "exportar" && (
            <div>
              <SectionHeader title="Exportar" sub="Descarga el informe o los datos limpios. Todo se genera localmente en tu navegador." />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                {[
                  {
                    icon: IC.file, color: B.accent, label: "Informe Markdown",
                    desc: <>Informe completo en formato <code style={{ color: B.accent, background: B.accentSoft, padding: "1px 5px", borderRadius: 3 }}>.md</code>. Compatible con GitHub, Notion y Obsidian.</>,
                    btnLabel: "Descargar .md",
                    onClick: () => { const c = buildMarkdownReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations); downloadFile(c, `datapulse_${fileName.replace(/\.csv$/i, "")}.md`, "text/markdown"); },
                  },
                  {
                    icon: IC.network, color: B.purple, label: "Informe HTML",
                    desc: <>Informe visual autocontenido en <code style={{ color: B.purple, background: B.purpleSoft, padding: "1px 5px", borderRadius: 3 }}>.html</code>. Dark theme. Compártelo o adjúntalo a un correo.</>,
                    btnLabel: "Descargar .html",
                    onClick: () => { const c = buildHTMLReport(fileName, headers, rows, types, statsMap, quality, insights, recommendations); downloadFile(c, `datapulse_${fileName.replace(/\.csv$/i, "")}.html`, "text/html"); },
                  },
                  {
                    icon: IC.check, color: B.green, label: "CSV Limpio",
                    desc: <>{quality.duplicates > 0 ? <><span style={{ color: B.highlight }}>Se eliminarán {quality.duplicates} duplicados.</span> Dataset </> : "Dataset "}sin filas duplicadas listo para análisis posterior.</>,
                    btnLabel: "Descargar CSV limpio",
                    onClick: () => { const c = buildCleanCSV(headers, filteredRows); downloadFile(c, `datapulse_clean_${fileName}`, "text/csv"); },
                  },
                ].map(({ icon, color, label, desc, btnLabel, onClick }) => (
                  <div key={label} style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column", borderTop: `3px solid ${color}` }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: `${color}18`, border: `1px solid ${color}33`, marginBottom: 14 }}>
                      <Ico d={icon} size={18} color={color} />
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: B.textPrimary, marginBottom: 8 }}>{label}</div>
                    <div style={{ fontSize: 12, color: B.textMuted, lineHeight: 1.7, flex: 1, marginBottom: 18 }}>{desc}</div>
                    <button onClick={onClick} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: `${color}15`, border: `1px solid ${color}`, color, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s" }}>
                      <Ico d={IC.download} size={14} color={color} />
                      {btnLabel}
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 20, padding: "12px 16px", background: B.highlightSoft, border: `1px solid rgba(245,166,35,0.2)`, borderRadius: 10, fontSize: 12, color: B.textMuted, lineHeight: 1.6 }}>
                <span style={{ color: B.highlight, fontWeight: 600 }}>Privacidad:</span> Todos los archivos se generan localmente. No se envía ningún dato a servidores externos.
              </div>
            </div>
          )}
        </div>

        {/* ── AI Panel ── */}
        <div style={{ borderTop: `1px solid ${B.cardBorder}`, padding: "20px 24px", background: B.surface, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 3px", background: `linear-gradient(135deg, #A78BFA, ${B.accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", display: "inline-block" }}>
                Insights con IA
              </h3>
              <p style={{ color: B.textMuted, fontSize: 11, margin: 0 }}>Gemini analiza el resumen estadístico (no el CSV completo).</p>
            </div>
            <button
              disabled={aiLoading}
              onClick={async () => {
                setAiLoading(true); setAiError(null); setAiInsights(null);
                try { setAiInsights(await generateAIInsights(headers, rows, types, statsMap, quality)); }
                catch (err) { setAiError(err.message); }
                finally { setAiLoading(false); }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                background: aiLoading ? "rgba(129,140,248,0.06)" : "linear-gradient(135deg, rgba(129,140,248,0.18), rgba(0,212,255,0.18))",
                border: `1px solid rgba(129,140,248,0.4)`, color: aiLoading ? B.textMuted : "#C4B5FD",
                borderRadius: 10, padding: "9px 18px", cursor: aiLoading ? "not-allowed" : "pointer",
                fontSize: 12, fontFamily: "inherit", fontWeight: 600, transition: "all 0.2s",
              }}
            >
              <span className={aiLoading ? "dp-spin" : ""}><Ico d={IC.sparkles} size={14} color={aiLoading ? B.textMuted : "#C4B5FD"} /></span>
              {aiLoading ? "Analizando..." : "Generar insights con IA"}
            </button>
          </div>

          {aiError === "NO_API_KEY" && (
            <div style={{ padding: "14px 18px", background: B.purpleSoft, border: `1px solid rgba(129,140,248,0.25)`, borderRadius: 10, fontSize: 13, lineHeight: 1.8 }}>
              <div style={{ fontWeight: 700, color: "#C4B5FD", marginBottom: 6 }}>Configura tu API key de Gemini</div>
              <ol style={{ color: B.textSecondary, margin: "0 0 0 16px", padding: 0, fontSize: 12 }}>
                <li>Obtén una key gratuita en <strong style={{ color: "#A78BFA" }}>aistudio.google.com/app/apikey</strong></li>
                <li>Crea el archivo <code style={{ color: B.accent, background: B.accentSoft, padding: "1px 5px", borderRadius: 3 }}>.env</code> en la raíz del proyecto</li>
                <li>Agrega: <code style={{ color: B.accent, background: B.accentSoft, padding: "1px 5px", borderRadius: 3 }}>VITE_GEMINI_API_KEY=tu_key_aqui</code></li>
                <li>Reinicia el servidor (<code style={{ color: B.accent }}>npm run dev</code>)</li>
              </ol>
            </div>
          )}

          {aiError && aiError !== "NO_API_KEY" && (
            <div style={{ padding: "12px 16px", background: B.redSoft, border: `1px solid rgba(239,68,68,0.25)`, borderRadius: 10, fontSize: 13, color: "#FCA5A5" }}>
              {aiError === "QUOTA_EXCEEDED"   && "Cuota de la API agotada. Espera unos minutos (Gemini free tier: 15 req/min)."}
              {aiError === "API_KEY_INVALID"  && "API key inválida o sin permisos. Verifica en aistudio.google.com/app/apikey"}
              {aiError === "EMPTY_RESPONSE"   && "Gemini devolvió una respuesta vacía. Intenta de nuevo."}
              {!["QUOTA_EXCEEDED", "API_KEY_INVALID", "EMPTY_RESPONSE"].includes(aiError) && `Error: ${aiError}`}
            </div>
          )}

          {aiLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[80, 60, 90, 55].map((w, i) => (
                <div key={i} className="dp-shimmer" style={{ height: 12, background: `linear-gradient(90deg, ${B.cardBorder} 25%, rgba(129,140,248,0.1) 50%, ${B.cardBorder} 75%)`, borderRadius: 6, width: `${w}%` }} />
              ))}
            </div>
          )}

          {aiInsights && !aiLoading && (
            <div style={{ padding: "16px 18px", background: "rgba(129,140,248,0.06)", border: `1px solid rgba(129,140,248,0.2)`, borderRadius: 10 }}>
              <div style={{ fontSize: 10, color: "#A78BFA", marginBottom: 10, letterSpacing: "0.1em", fontWeight: 700 }}>GEMINI 2.0 FLASH · ANÁLISIS IA</div>
              <div style={{ fontSize: 13, color: B.textSecondary, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{aiInsights}</div>
              <div style={{ marginTop: 12, fontSize: 11, color: B.textMuted }}>Los insights de IA complementan — no reemplazan — el análisis estadístico.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
