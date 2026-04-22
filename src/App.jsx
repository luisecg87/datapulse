import { useState, useCallback, useMemo, useRef } from "react";

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
  return {
    count: nums.length, missing: values.length - nums.length,
    min: sorted[0], max: sorted[sorted.length - 1],
    mean, median, std, q1, q3, outliers,
    sum
  };
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

// ── Mini Chart Components (SVG) ──────────────────────────────────
function MiniBar({ data, width = 300, height = 140, color = "#6EE7B7" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.value), 1);
  const barW = Math.max(8, Math.min(36, (width - 40) / data.length - 4));
  const chartW = data.length * (barW + 4) + 20;
  return (
    <svg width={Math.min(chartW, width)} height={height} style={{ overflow: "visible" }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 32);
        return (
          <g key={i}>
            <rect x={i * (barW + 4) + 10} y={height - 18 - h} width={barW} height={h}
              rx={3} fill={color} opacity={0.85} />
            <text x={i * (barW + 4) + 10 + barW / 2} y={height - 4}
              textAnchor="middle" fontSize="9" fill="#94a3b8" fontFamily="monospace">
              {d.label.length > 6 ? d.label.slice(0, 5) + "…" : d.label}
            </text>
            <text x={i * (barW + 4) + 10 + barW / 2} y={height - 22 - h}
              textAnchor="middle" fontSize="9" fill="#cbd5e1" fontFamily="monospace">
              {fmt(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MiniLine({ data, width = 300, height = 120, color = "#60A5FA" }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pad = 10;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });
  return (
    <svg width={width} height={height}>
      <defs>
        <linearGradient id={`lg-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`${pad},${height - pad} ${points.join(" ")} ${width - pad},${height - pad}`}
        fill={`url(#lg-${color.replace("#", "")})`}
      />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {data.length <= 30 && data.map((v, i) => {
        const x = pad + (i / (data.length - 1)) * (width - pad * 2);
        const y = pad + (1 - (v - min) / range) * (height - pad * 2);
        return <circle key={i} cx={x} cy={y} r={2.5} fill={color} />;
      })}
    </svg>
  );
}

// ── Insight Generator ────────────────────────────────────────────
function generateInsights(headers, rows, types, statsMap, correlations) {
  const insights = [];
  // Missing data
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.missing > rows.length * 0.1) {
      insights.push({ type: "warning", icon: "⚠️", text: `"${col}" tiene ${s.missing} valores vacíos (${(s.missing / rows.length * 100).toFixed(0)}%). Esto puede afectar análisis posteriores.` });
    }
  });
  // Outliers
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.outliers > 0) {
      insights.push({ type: "info", icon: "🔍", text: `"${col}" contiene ${s.outliers} valores atípicos (outliers) fuera del rango intercuartílico. Revisa si son errores o datos reales.` });
    }
  });
  // Correlations
  correlations.filter(c => Math.abs(c.r) > 0.7).forEach(c => {
    const dir = c.r > 0 ? "positiva" : "negativa";
    insights.push({ type: "success", icon: "📈", text: `Correlación ${dir} fuerte (r=${c.r.toFixed(2)}) entre "${c.a}" y "${c.b}". ${c.r > 0 ? "Cuando una sube, la otra también." : "Cuando una sube, la otra baja."}` });
  });
  // Distribution
  Object.entries(statsMap).forEach(([col, s]) => {
    if (s && s.std > s.mean * 1.5 && s.mean !== 0) {
      insights.push({ type: "info", icon: "📊", text: `"${col}" tiene alta variabilidad (desv. estándar ${fmt(s.std)} vs media ${fmt(s.mean)}). Los datos están muy dispersos.` });
    }
  });
  // Top category
  headers.forEach((h, i) => {
    if (types[i] === "categorical") {
      const counts = {};
      rows.forEach(r => { const v = r[i]; if (v) counts[v] = (counts[v] || 0) + 1; });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1) {
        const pct = (sorted[0][1] / rows.length * 100).toFixed(0);
        insights.push({ type: "info", icon: "🏷️", text: `En "${h}", el valor más frecuente es "${sorted[0][0]}" con ${pct}% de los registros.` });
      }
    }
  });
  if (insights.length === 0) {
    insights.push({ type: "success", icon: "✅", text: "Los datos se ven limpios y consistentes. No se detectaron problemas evidentes." });
  }
  return insights.slice(0, 8);
}

// ── Main App ─────────────────────────────────────────────────────
const BRAND = {
  bg: "#0B1121",
  card: "#111827",
  cardBorder: "#1E293B",
  accent: "#10B981",
  accentSoft: "rgba(16,185,129,0.12)",
  blue: "#3B82F6",
  purple: "#8B5CF6",
  amber: "#F59E0B",
  red: "#EF4444",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
};

const cardStyle = {
  background: BRAND.card,
  border: `1px solid ${BRAND.cardBorder}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
};

export default function DataPulse() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("resumen");
  const fileRef = useRef();

  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = parseCSV(text);
      if (parsed.rows.length === 0) return;
      setData(parsed);

      // Run analysis
      const types = parsed.headers.map((_, i) =>
        detectType(parsed.rows.map(r => r[i]))
      );
      const statsMap = {};
      parsed.headers.forEach((h, i) => {
        if (types[i] === "numeric") {
          statsMap[h] = computeStats(parsed.rows.map(r => r[i]));
        }
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
          catBreakdowns[h] = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
            .map(([label, value]) => ({ label, value }));
        }
      });
      const insights = generateInsights(parsed.headers, parsed.rows, types, statsMap, correlations);
      setAnalysis({ types, statsMap, correlations, catBreakdowns, insights });
      setActiveTab("resumen");
    };
    reader.readAsText(file);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // ── Render ──
  if (!data) {
    return (
      <div style={{
        minHeight: "100vh", background: BRAND.bg, display: "flex",
        alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        padding: 20,
      }}>
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚡</div>
          <h1 style={{
            fontSize: 36, fontWeight: 800, color: BRAND.textPrimary,
            letterSpacing: "-0.03em", margin: "0 0 4px",
            background: `linear-gradient(135deg, ${BRAND.accent}, ${BRAND.blue})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            DataPulse
          </h1>
          <p style={{ color: BRAND.textMuted, fontSize: 13, margin: "0 0 32px", letterSpacing: "0.05em" }}>
            by ErnestLab
          </p>
          <p style={{ color: BRAND.textSecondary, fontSize: 15, margin: "0 0 28px", lineHeight: 1.6 }}>
            Sube tu archivo CSV y obtén un informe completo con estadísticas, visualizaciones e insights accionables en segundos.
          </p>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? BRAND.accent : BRAND.cardBorder}`,
              borderRadius: 16,
              padding: "48px 32px",
              cursor: "pointer",
              background: dragOver ? BRAND.accentSoft : "rgba(17,24,39,0.6)",
              transition: "all 0.2s",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
            <p style={{ color: BRAND.textPrimary, fontSize: 15, margin: "0 0 6px", fontWeight: 600 }}>
              Arrastra tu CSV aquí
            </p>
            <p style={{ color: BRAND.textMuted, fontSize: 13, margin: 0 }}>
              o haz clic para seleccionar archivo
            </p>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt"
              style={{ display: "none" }}
              onChange={(e) => handleFile(e.target.files[0])} />
          </div>

          <div style={{
            marginTop: 32, padding: 16, background: "rgba(17,24,39,0.4)",
            borderRadius: 10, border: `1px solid ${BRAND.cardBorder}`,
          }}>
            <p style={{ color: BRAND.textMuted, fontSize: 12, margin: 0, lineHeight: 1.7 }}>
              🔒 Tus datos se procesan localmente en tu navegador. No se envían a ningún servidor.
              <br />Soporta CSV con separadores coma (,) o punto y coma (;).
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { headers, rows } = data;
  const { types, statsMap, correlations, catBreakdowns, insights } = analysis;
  const numericCols = headers.filter((_, i) => types[i] === "numeric");
  const catCols = headers.filter((_, i) => types[i] === "categorical");

  const tabs = [
    { id: "resumen", label: "Resumen", icon: "📊" },
    { id: "columnas", label: "Columnas", icon: "📋" },
    { id: "correlaciones", label: "Correlaciones", icon: "🔗" },
    { id: "insights", label: "Insights", icon: "💡" },
    { id: "datos", label: "Datos", icon: "📄" },
  ];

  return (
    <div style={{
      minHeight: "100vh", background: BRAND.bg,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      color: BRAND.textPrimary,
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 24px", borderBottom: `1px solid ${BRAND.cardBorder}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span style={{
            fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em",
            background: `linear-gradient(135deg, ${BRAND.accent}, ${BRAND.blue})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>DataPulse</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: BRAND.textMuted, fontSize: 12 }}>📄 {fileName}</span>
          <button onClick={() => { setData(null); setAnalysis(null); setFileName(""); }}
            style={{
              background: "rgba(239,68,68,0.15)", border: `1px solid rgba(239,68,68,0.3)`,
              color: "#FCA5A5", borderRadius: 8, padding: "6px 14px",
              cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            }}>
            Nuevo archivo
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div style={{
        padding: "20px 24px 8px", display: "flex", gap: 12, flexWrap: "wrap",
      }}>
        {[
          { label: "Filas", value: rows.length.toLocaleString(), icon: "📐", color: BRAND.accent },
          { label: "Columnas", value: headers.length, icon: "📊", color: BRAND.blue },
          { label: "Numéricas", value: numericCols.length, icon: "🔢", color: BRAND.purple },
          { label: "Categóricas", value: catCols.length, icon: "🏷️", color: BRAND.amber },
        ].map((kpi, i) => (
          <div key={i} style={{
            flex: "1 1 120px", ...cardStyle, marginBottom: 0, padding: "14px 16px",
            borderLeft: `3px solid ${kpi.color}`,
          }}>
            <div style={{ fontSize: 11, color: BRAND.textMuted, marginBottom: 4 }}>{kpi.icon} {kpi.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{
        padding: "16px 24px 0", display: "flex", gap: 4,
        borderBottom: `1px solid ${BRAND.cardBorder}`, overflowX: "auto",
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background: activeTab === t.id ? BRAND.accentSoft : "transparent",
            border: "none",
            borderBottom: activeTab === t.id ? `2px solid ${BRAND.accent}` : "2px solid transparent",
            color: activeTab === t.id ? BRAND.accent : BRAND.textMuted,
            padding: "10px 16px", cursor: "pointer", fontSize: 12,
            fontFamily: "inherit", fontWeight: activeTab === t.id ? 600 : 400,
            whiteSpace: "nowrap", transition: "all 0.15s",
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "20px 24px 40px" }}>

        {/* ── Resumen ── */}
        {activeTab === "resumen" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px", color: BRAND.textPrimary }}>
              Vista general del dataset
            </h2>
            {/* Numeric summaries */}
            {numericCols.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
                {numericCols.map(col => {
                  const s = statsMap[col];
                  const idx = headers.indexOf(col);
                  const values = rows.map(r => toNum(r[idx])).filter(v => !isNaN(v));
                  return (
                    <div key={col} style={cardStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.blue }}>🔢 {col}</span>
                        <span style={{ fontSize: 10, color: BRAND.textMuted, background: "rgba(59,130,246,0.1)", padding: "2px 8px", borderRadius: 4 }}>numérica</span>
                      </div>
                      <MiniLine data={values.slice(0, 60)} width={260} height={70} color={BRAND.blue} />
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 10 }}>
                        {[
                          ["Media", fmt(s.mean)], ["Mediana", fmt(s.median)], ["Desv.", fmt(s.std)],
                          ["Mín", fmt(s.min)], ["Máx", fmt(s.max)], ["Outliers", s.outliers],
                        ].map(([l, v], i) => (
                          <div key={i} style={{ fontSize: 11 }}>
                            <span style={{ color: BRAND.textMuted }}>{l}: </span>
                            <span style={{ color: BRAND.textPrimary, fontWeight: 600 }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Categorical */}
            {catCols.length > 0 && (
              <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
                {catCols.map(col => (
                  <div key={col} style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.amber }}>🏷️ {col}</span>
                      <span style={{ fontSize: 10, color: BRAND.textMuted, background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4 }}>categórica</span>
                    </div>
                    <MiniBar data={catBreakdowns[col]} width={260} height={120} color={BRAND.amber} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Columnas ── */}
        {activeTab === "columnas" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Detalle por columna</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BRAND.cardBorder}` }}>
                    {["Columna", "Tipo", "No vacíos", "Únicos", "Ejemplo"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: BRAND.textMuted, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {headers.map((h, i) => {
                    const vals = rows.map(r => r[i]).filter(v => v !== "");
                    const unique = new Set(vals).size;
                    const typeLabel = { numeric: "🔢 Numérica", categorical: "🏷️ Categórica", date: "📅 Fecha", text: "📝 Texto", empty: "⚫ Vacía" }[types[i]];
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${BRAND.cardBorder}` }}>
                        <td style={{ padding: "10px 12px", fontWeight: 600, color: BRAND.textPrimary }}>{h}</td>
                        <td style={{ padding: "10px 12px", color: BRAND.textSecondary }}>{typeLabel}</td>
                        <td style={{ padding: "10px 12px", color: BRAND.textSecondary }}>{vals.length}/{rows.length}</td>
                        <td style={{ padding: "10px 12px", color: BRAND.textSecondary }}>{unique}</td>
                        <td style={{ padding: "10px 12px", color: BRAND.textMuted, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{vals[0] || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Correlaciones ── */}
        {activeTab === "correlaciones" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>Matriz de correlaciones</h2>
            <p style={{ color: BRAND.textMuted, fontSize: 12, margin: "0 0 16px" }}>
              Valores entre -1 (inversa perfecta) y +1 (directa perfecta). Resaltadas las correlaciones fuertes.
            </p>
            {numericCols.length < 2 ? (
              <div style={cardStyle}>
                <p style={{ color: BRAND.textMuted, fontSize: 13 }}>Se necesitan al menos 2 columnas numéricas para calcular correlaciones.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 8 }}></th>
                      {numericCols.map(c => (
                        <th key={c} style={{ padding: 8, color: BRAND.textMuted, fontWeight: 600, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {numericCols.map((a, ai) => (
                      <tr key={a}>
                        <td style={{ padding: 8, fontWeight: 600, color: BRAND.textSecondary, whiteSpace: "nowrap" }}>{a}</td>
                        {numericCols.map((b, bi) => {
                          if (ai === bi) return <td key={b} style={{ padding: 8, textAlign: "center", color: BRAND.textMuted }}>1.00</td>;
                          const c = correlations.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
                          const r = c ? c.r : null;
                          const abs = r != null ? Math.abs(r) : 0;
                          const bg = abs > 0.7 ? (r > 0 ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)")
                            : abs > 0.4 ? "rgba(245,158,11,0.12)" : "transparent";
                          return (
                            <td key={b} style={{ padding: 8, textAlign: "center", background: bg, borderRadius: 4, color: BRAND.textPrimary, fontWeight: abs > 0.7 ? 700 : 400 }}>
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

        {/* ── Insights ── */}
        {activeTab === "insights" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>
              💡 Insights automáticos
            </h2>
            <p style={{ color: BRAND.textMuted, fontSize: 12, margin: "0 0 16px" }}>
              Hallazgos detectados automáticamente en tus datos.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {insights.map((ins, i) => {
                const colors = {
                  warning: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.3)" },
                  info: { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.3)" },
                  success: { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.3)" },
                };
                const c = colors[ins.type] || colors.info;
                return (
                  <div key={i} style={{
                    padding: "14px 16px", background: c.bg,
                    border: `1px solid ${c.border}`, borderRadius: 10,
                    fontSize: 13, lineHeight: 1.6, color: BRAND.textPrimary,
                  }}>
                    {ins.icon} {ins.text}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Datos ── */}
        {activeTab === "datos" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 8px" }}>
              Vista de datos
            </h2>
            <p style={{ color: BRAND.textMuted, fontSize: 12, margin: "0 0 16px" }}>
              Mostrando las primeras {Math.min(100, rows.length)} de {rows.length} filas.
            </p>
            <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${BRAND.cardBorder}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "rgba(30,41,59,0.5)" }}>
                    <th style={{ padding: "8px 10px", color: BRAND.textMuted, textAlign: "center", fontWeight: 600 }}>#</th>
                    {headers.map(h => (
                      <th key={h} style={{ padding: "8px 10px", color: BRAND.textMuted, textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r, ri) => (
                    <tr key={ri} style={{ borderTop: `1px solid ${BRAND.cardBorder}` }}>
                      <td style={{ padding: "6px 10px", color: BRAND.textMuted, textAlign: "center" }}>{ri + 1}</td>
                      {r.map((v, ci) => (
                        <td key={ci} style={{
                          padding: "6px 10px", color: BRAND.textSecondary,
                          maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>{v || "—"}</td>
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
