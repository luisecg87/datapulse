import { useState, useCallback, useMemo, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, Legend, ReferenceLine
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
        insights.push({ type: "info", icon: "🏷️", text: `En "${h}", el valor más frecuente es "${sorted[0][0]}" con ${pct}% de registros.` });
      }
    }
  });
  if (insights.length === 0)
    insights.push({ type: "success", icon: "✅", text: "Datos limpios y consistentes. No se detectaron problemas evidentes." });
  return insights.slice(0, 8);
}

// ── Custom Tooltip ───────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: "#1E293B", border: "1px solid #334155", borderRadius: 8,
      padding: "10px 14px", fontSize: 12, fontFamily: "monospace",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    }}>
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
    <div style={{
      background: "#1E293B", border: "1px solid #334155", borderRadius: 8,
      padding: "10px 14px", fontSize: 12, fontFamily: "monospace",
    }}>
      <p style={{ color: "#60A5FA", margin: "2px 0" }}>X: {fmt(d?.x)}</p>
      <p style={{ color: "#10B981", margin: "2px 0" }}>Y: {fmt(d?.y)}</p>
    </div>
  );
};

// ── Brand ────────────────────────────────────────────────────────
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

// ── Main App ─────────────────────────────────────────────────────
export default function DataPulse() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("resumen");

  // Filter state
  const [catFilters, setCatFilters] = useState({});       // { colName: Set(selectedValues) }
  const [numFilters, setNumFilters] = useState({});        // { colName: [min, max] }

  // Explorer state
  const [explorerX, setExplorerX] = useState("");
  const [explorerY, setExplorerY] = useState("");
  const [explorerType, setExplorerType] = useState("bar");

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

      // Init filters
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

      setCatFilters(initCat);
      setNumFilters(initNum);
      setExplorerX(numericCols[0] || "");
      setExplorerY(numericCols[1] || numericCols[0] || "");
      setAnalysis({ types, statsMap, correlations, catBreakdowns, insights: generateInsights(parsed.headers, parsed.rows, types, statsMap, correlations) });
      setActiveTab("resumen");
    };
    reader.readAsText(file);
  }, []);

  // ── Filtered rows ────────────────────────────────────────────
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

  // ── Explorer data (must be before any early return) ──────────
  const explorerData = useMemo(() => {
    if (!data || !analysis || !explorerX) return [];
    const { headers, rows } = data;
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
      return Object.values(counts)
        .sort((a, b) => b.count - a.count).slice(0, 20)
        .map(d => ({ label: d.label, value: yIdx >= 0 && d.n > 0 ? d.sum / d.n : d.count }));
    } else {
      return filteredRows.slice(0, 500).map((r, i) => ({
        x: toNum(r[xIdx]),
        y: yIdx >= 0 ? toNum(r[yIdx]) : i,
      })).filter(d => !isNaN(d.x) && !isNaN(d.y));
    }
  }, [data, analysis, explorerX, explorerY, filteredRows]);

  // ── Upload Screen ────────────────────────────────────────────
  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: B.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', monospace", padding: 20 }}>
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 36, fontWeight: 800, color: B.textPrimary, letterSpacing: "-0.03em", margin: "0 0 4px", background: `linear-gradient(135deg, ${B.accent}, ${B.blue})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            DataPulse
          </h1>
          <p style={{ color: B.textMuted, fontSize: 13, margin: "0 0 32px", letterSpacing: "0.05em" }}>by ErnestoLab</p>
          <p style={{ color: B.textSecondary, fontSize: 15, margin: "0 0 28px", lineHeight: 1.6 }}>
            Sube tu CSV y obtén estadísticas, gráficas interactivas y filtros en segundos.
          </p>
          <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => fileRef.current?.click()}
            style={{ border: `2px dashed ${dragOver ? B.accent : B.cardBorder}`, borderRadius: 16, padding: "48px 32px", cursor: "pointer", background: dragOver ? B.accentSoft : "rgba(17,24,39,0.6)", transition: "all 0.2s" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
            <p style={{ color: B.textPrimary, fontSize: 15, margin: "0 0 6px", fontWeight: 600 }}>Arrastra tu CSV aquí</p>
            <p style={{ color: B.textMuted, fontSize: 13, margin: 0 }}>o haz clic para seleccionar archivo</p>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
          </div>
          <p style={{ color: B.textMuted, fontSize: 11, marginTop: 20 }}>🔒 Datos procesados localmente. No se envían a ningún servidor.</p>
        </div>
      </div>
    );
  }

  const { headers, rows } = data;
  const { types, statsMap, correlations, catBreakdowns, insights } = analysis;
  const numericCols = headers.filter((_, i) => types[i] === "numeric");
  const catCols = headers.filter((_, i) => types[i] === "categorical");

  const activeFiltersCount = Object.entries(catFilters).reduce((acc, [col, s]) => {
    const allVals = [...new Set(rows.map(r => r[headers.indexOf(col)]).filter(Boolean))];
    return acc + (s.size < allVals.length ? 1 : 0);
  }, 0) + Object.entries(numFilters).reduce((acc, [col, [mn, mx]]) => {
    const s = statsMap[col];
    return acc + (s && (mn > s.min || mx < s.max) ? 1 : 0);
  }, 0);

  const tabs = [
    { id: "resumen", label: "Resumen", icon: "📊" },
    { id: "explorador", label: "Explorador", icon: "🔭" },
    { id: "filtros", label: `Filtros${activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ""}`, icon: "🎛️" },
    { id: "correlaciones", label: "Correlaciones", icon: "🔗" },
    { id: "insights", label: "Insights", icon: "💡" },
    { id: "datos", label: "Datos", icon: "📄" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: "'JetBrains Mono', monospace", color: B.textPrimary }}>

      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${B.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${B.accent}, ${B.blue})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>DataPulse</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {activeFiltersCount > 0 && (
            <span style={{ fontSize: 11, color: B.amber, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 6, padding: "3px 8px" }}>
              🎛️ {activeFiltersCount} filtro{activeFiltersCount > 1 ? "s" : ""} activo{activeFiltersCount > 1 ? "s" : ""} — {filteredRows.length.toLocaleString()} filas
            </span>
          )}
          <span style={{ color: B.textMuted, fontSize: 12 }}>📄 {fileName}</span>
          <button onClick={() => { setData(null); setAnalysis(null); setFileName(""); setCatFilters({}); setNumFilters({}); }}
            style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#FCA5A5", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
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
        ].map((kpi, i) => (
          <div key={i} style={{ flex: "1 1 140px", ...card, marginBottom: 0, padding: "14px 16px", borderLeft: `3px solid ${kpi.color}` }}>
            <div style={{ fontSize: 11, color: B.textMuted, marginBottom: 4 }}>{kpi.icon} {kpi.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
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
            padding: "10px 16px", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
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
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Vista general del dataset</h2>

            {numericCols.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
                {numericCols.map(col => {
                  const s = statsMap[col];
                  const idx = headers.indexOf(col);
                  const lineData = filteredRows.slice(0, 80).map((r, i) => ({ i, v: toNum(r[idx]) })).filter(d => !isNaN(d.v));
                  return (
                    <div key={col} style={card}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: B.blue }}>🔢 {col}</span>
                        <span style={{ fontSize: 10, color: B.textMuted, background: "rgba(59,130,246,0.1)", padding: "2px 8px", borderRadius: 4 }}>numérica</span>
                      </div>
                      <ResponsiveContainer width="100%" height={80}>
                        <LineChart data={lineData}>
                          <Line type="monotone" dataKey="v" stroke={B.blue} strokeWidth={2} dot={false} />
                          <Tooltip content={<CustomTooltip />} />
                          <ReferenceLine y={s?.mean} stroke={B.accent} strokeDasharray="3 3" />
                        </LineChart>
                      </ResponsiveContainer>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 12 }}>
                        {[["Media", fmt(s?.mean)], ["Mediana", fmt(s?.median)], ["Desv.", fmt(s?.std)],
                          ["Mín", fmt(s?.min)], ["Máx", fmt(s?.max)], ["Outliers", s?.outliers ?? "—"]].map(([l, v], i) => (
                          <div key={i} style={{ fontSize: 11 }}>
                            <span style={{ color: B.textMuted }}>{l}: </span>
                            <span style={{ color: B.textPrimary, fontWeight: 600 }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {catCols.length > 0 && (
              <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
                {catCols.map(col => {
                  const idx = headers.indexOf(col);
                  const counts = {};
                  filteredRows.forEach(r => { const v = r[idx]; if (v) counts[v] = (counts[v] || 0) + 1; });
                  const chartData = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }));
                  return (
                    <div key={col} style={card}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: B.amber }}>🏷️ {col}</span>
                        <span style={{ fontSize: 10, color: B.textMuted, background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4 }}>categórica</span>
                      </div>
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                          <XAxis dataKey="label" tick={{ fill: B.textMuted, fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                          <YAxis tick={{ fill: B.textMuted, fontSize: 10 }} />
                          <Tooltip content={<CustomTooltip />} />
                          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                            {chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── EXPLORADOR ── */}
        {activeTab === "explorador" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>🔭 Explorador de variables</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 20px" }}>Selecciona variables para cruzarlas y visualizarlas. Los filtros activos se aplican aquí también.</p>

            {/* Controls */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Eje X / Variable principal</label>
                <select value={explorerX} onChange={e => setExplorerX(e.target.value)}
                  style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Eje Y / Métrica</label>
                <select value={explorerY} onChange={e => setExplorerY(e.target.value)}
                  style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  <option value="">— conteo —</option>
                  {numericCols.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: B.textMuted }}>Tipo de gráfica</label>
                <select value={explorerType} onChange={e => setExplorerType(e.target.value)}
                  style={{ background: B.card, border: `1px solid ${B.cardBorder}`, color: B.textPrimary, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                  <option value="bar">Barras</option>
                  <option value="line">Líneas</option>
                  <option value="scatter">Dispersión</option>
                </select>
              </div>
            </div>

            {/* Chart */}
            <div style={{ ...card, padding: 24 }}>
              <div style={{ marginBottom: 12, fontSize: 13, color: B.textSecondary }}>
                <strong style={{ color: B.textPrimary }}>{explorerX}</strong>
                {explorerY && <> vs <strong style={{ color: B.accent }}>{explorerY}</strong></>}
                <span style={{ color: B.textMuted, marginLeft: 8 }}>({filteredRows.length.toLocaleString()} registros)</span>
              </div>

              {explorerType === "scatter" && numericCols.includes(explorerX) ? (
                <ResponsiveContainer width="100%" height={360}>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={B.cardBorder} />
                    <XAxis dataKey="x" name={explorerX} tick={{ fill: B.textMuted, fontSize: 11 }} label={{ value: explorerX, position: "insideBottom", offset: -10, fill: B.textMuted, fontSize: 11 }} />
                    <YAxis dataKey="y" name={explorerY || "índice"} tick={{ fill: B.textMuted, fontSize: 11 }} />
                    <Tooltip content={<ScatterTooltip />} />
                    <Scatter data={explorerData} fill={B.accent} fillOpacity={0.7} />
                  </ScatterChart>
                </ResponsiveContainer>
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
                    <Tooltip content={<CustomTooltip />} />
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
                  if (types[i] === "categorical") {
                    initCat[h] = new Set([...new Set(rows.map(r => r[i]).filter(Boolean))]);
                  }
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

            {/* Categorical filters */}
            {catCols.map(col => {
              const idx = headers.indexOf(col);
              const allVals = [...new Set(rows.map(r => r[idx]).filter(Boolean))].sort();
              const selected = catFilters[col] || new Set(allVals);
              return (
                <div key={col} style={{ ...card }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: B.amber }}>🏷️ {col}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set(allVals) }))}
                        style={{ fontSize: 11, color: B.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Todo</button>
                      <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set() }))}
                        style={{ fontSize: 11, color: B.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Ninguno</button>
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
                        }} style={{
                          padding: "4px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                          border: `1px solid ${active ? B.amber : B.cardBorder}`,
                          background: active ? "rgba(245,158,11,0.15)" : "transparent",
                          color: active ? B.amber : B.textMuted,
                          transition: "all 0.15s",
                        }}>
                          {val}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Numeric filters */}
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
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: B.textMuted }}>Rango original: {fmt(s.min)} — {fmt(s.max)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── CORRELACIONES ── */}
        {activeTab === "correlaciones" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>Matriz de correlaciones</h2>
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>
              Valores entre -1 (inversa perfecta) y +1 (directa perfecta).
            </p>
            {numericCols.length < 2 ? (
              <div style={card}><p style={{ color: B.textMuted, fontSize: 13 }}>Se necesitan al menos 2 columnas numéricas.</p></div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 8 }}></th>
                      {numericCols.map(c => (
                        <th key={c} style={{ padding: 8, color: B.textMuted, fontWeight: 600, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</th>
                      ))}
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
            <p style={{ color: B.textMuted, fontSize: 12, margin: "0 0 16px" }}>Hallazgos detectados automáticamente.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {insights.map((ins, i) => {
                const colors = { warning: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.3)" }, info: { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.3)" }, success: { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.3)" } };
                const c = colors[ins.type] || colors.info;
                return (
                  <div key={i} style={{ padding: "14px 16px", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 13, lineHeight: 1.6 }}>
                    {ins.icon} {ins.text}
                  </div>
                );
              })}
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
                        <td key={ci} style={{ padding: "6px 10px", color: B.textSecondary, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
