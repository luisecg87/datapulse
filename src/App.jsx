import { useState, useCallback, useMemo, useRef } from "react";
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
    const result = []; let current = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === sep && !inQuotes) { result.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    result.push(current.trim()); return result;
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
      insights.push({ type: "warning", icon: "⚠️", text: `"${col}" tiene ${s.missing} valores vacíos (${(s.missing / rows.length * 100).toFixed(0)}%).` });
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
      if (sorted.length > 1)
        insights.push({ type: "info", icon: "🏷️", text: `En "${h}", el valor más frecuente es "${sorted[0][0]}" con ${(sorted[0][1] / rows.length * 100).toFixed(0)}%.` });
    }
  });
  if (insights.length === 0)
    insights.push({ type: "success", icon: "✅", text: "Datos limpios y consistentes. No se detectaron problemas evidentes." });
  return insights.slice(0, 8);
}

// ── Design tokens ─────────────────────────────────────────────────
const T = {
  bg:       "#0A0F1E",
  bg1:      "#0E1426",
  bg2:      "#131A30",
  bg3:      "#1A2240",
  line:     "rgba(255,255,255,0.06)",
  line2:    "rgba(255,255,255,0.12)",
  line3:    "rgba(255,255,255,0.22)",
  accent:   "#00D4FF",
  accentDim:"rgba(0,212,255,0.12)",
  accentLine:"rgba(0,212,255,0.45)",
  amber:    "#F5A623",
  amberDim: "rgba(245,166,35,0.12)",
  fg:       "#E8ECF5",
  fg2:      "#A6AEC2",
  fg3:      "#6B7390",
  fg4:      "#444C68",
  pos:      "#00D4FF",
  neg:      "#F5A623",
};

const CHART_COLORS = [T.accent, T.amber, "#8B5CF6", "#10B981", "#EC4899", "#EF4444", "#06B6D4", "#84CC16"];

const mono = { fontFamily: "'Geist Mono', 'JetBrains Mono', monospace" };
const label = { ...mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: T.fg3 };

// ── Tooltips ───────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label: lbl }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.line2}`, borderRadius: 0, padding: "10px 14px", fontSize: 12, ...mono, boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
      {lbl && <p style={{ color: T.fg3, margin: "0 0 6px" }}>{lbl}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || T.accent, margin: "2px 0", fontWeight: 600 }}>
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
    <div style={{ background: T.bg2, border: `1px solid ${T.line2}`, padding: "10px 14px", fontSize: 12, ...mono }}>
      <p style={{ color: T.accent, margin: "2px 0" }}>X: {fmt(d?.x)}</p>
      <p style={{ color: T.amber, margin: "2px 0" }}>Y: {fmt(d?.y)}</p>
    </div>
  );
};

// ── Sidebar ────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: "resumen",      label: "Resumen",     icon: "▦" },
  { id: "explorador",   label: "Explorador",  icon: "◫" },
  { id: "filtros",      label: "Filtros",     icon: "⌥" },
  { id: "correlaciones",label: "Correlaciones",icon: "⌗" },
  { id: "insights",     label: "Insights",    icon: "✦" },
  { id: "limpieza",     label: "Limpieza",    icon: "⌬" },
  { id: "datos",        label: "Datos",       icon: "≡" },
];

function Sidebar({ active, onNav, collapsed, fileName, rowCount, colCount }) {
  const w = collapsed ? 56 : 208;
  return (
    <aside style={{
      width: w, minWidth: w, background: T.bg1,
      borderRight: `1px solid ${T.line2}`,
      display: "flex", flexDirection: "column",
      transition: "width 0.2s ease", overflow: "hidden",
      flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{
        height: 56, borderBottom: `1px solid ${T.line2}`,
        display: "flex", alignItems: "center",
        justifyContent: collapsed ? "center" : "flex-start",
        padding: collapsed ? 0 : "0 16px", gap: 10,
      }}>
        <div style={{
          width: 28, height: 28, border: `1px solid ${T.accent}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, position: "relative",
        }}>
          <div style={{ width: 10, height: 10, background: T.accent }} />
        </div>
        {!collapsed && (
          <div>
            <div style={{ ...mono, fontSize: 13, fontWeight: 500, color: T.fg, letterSpacing: "-0.01em" }}>DataPulse</div>
            <div style={{ ...mono, fontSize: 9, color: T.fg4, letterSpacing: "0.1em" }}>v 2.4</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: "12px 0", overflowY: "auto" }}>
        {!collapsed && <div style={{ ...label, padding: "0 16px", marginBottom: 8 }}>ESPACIO DE TRABAJO</div>}
        {NAV_ITEMS.map(item => {
          const isActive = active === item.id;
          return (
            <button key={item.id} onClick={() => onNav(item.id)} title={collapsed ? item.label : undefined}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                gap: 12, padding: collapsed ? "10px 0" : "9px 16px",
                justifyContent: collapsed ? "center" : "flex-start",
                background: isActive ? T.accentDim : "transparent",
                border: "none", borderLeft: isActive ? `2px solid ${T.accent}` : "2px solid transparent",
                color: isActive ? T.accent : T.fg3,
                cursor: "pointer", fontSize: 13, fontFamily: "inherit",
                transition: "all 0.15s", textAlign: "left",
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = T.fg; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = T.fg3; }}
            >
              <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && isActive && <span style={{ ...mono, fontSize: 9, color: T.accent, marginLeft: "auto" }}>●</span>}
            </button>
          );
        })}
      </nav>

      {/* Dataset footer */}
      {!collapsed && fileName && (
        <div style={{ borderTop: `1px solid ${T.line2}`, padding: 12 }}>
          <div style={{ ...label, marginBottom: 8 }}>DATASET ACTIVO</div>
          <div style={{ border: `1px solid ${T.line2}`, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ color: T.accent, fontSize: 11 }}>◈</span>
              <div style={{ ...mono, fontSize: 11, color: T.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div style={{ ...mono, fontSize: 9, color: T.fg4 }}>{rowCount?.toLocaleString()} fil</div>
              <div style={{ ...mono, fontSize: 9, color: T.fg4, textAlign: "right" }}>{colCount} col</div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Topbar ─────────────────────────────────────────────────────────
function Topbar({ collapsed, onToggle, activeTab, fileName, onReset }) {
  const tabLabel = NAV_ITEMS.find(n => n.id === activeTab)?.label || "";
  return (
    <header style={{
      height: 56, borderBottom: `1px solid ${T.line2}`,
      background: T.bg1, display: "flex", alignItems: "center",
      padding: "0 20px", gap: 16, flexShrink: 0,
    }}>
      {/* Collapse toggle */}
      <button onClick={onToggle} style={{
        background: "none", border: `1px solid ${T.line2}`, color: T.fg3,
        width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", flexShrink: 0, fontSize: 14,
        transition: "border-color 0.15s, color 0.15s",
      }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = T.line3; e.currentTarget.style.color = T.fg; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = T.line2; e.currentTarget.style.color = T.fg3; }}
        title={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
      >
        {collapsed ? "›" : "‹"}
      </button>

      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...mono, fontSize: 11, color: T.fg4 }}>DataPulse</span>
        <span style={{ color: T.line3, fontSize: 12 }}>/</span>
        <span style={{ ...mono, fontSize: 11, color: T.fg2 }}>{tabLabel}</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* File name chip */}
      {fileName && (
        <div style={{
          ...mono, fontSize: 11, color: T.fg3,
          border: `1px solid ${T.line2}`, padding: "4px 10px",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{ color: T.accent }}>◈</span> {fileName}
        </div>
      )}

      {/* Reset */}
      {fileName && (
        <button onClick={onReset} style={{
          ...mono, fontSize: 11, background: "rgba(245,166,35,0.1)",
          border: `1px solid rgba(245,166,35,0.3)`, color: T.amber,
          padding: "5px 12px", cursor: "pointer", fontFamily: "inherit",
          letterSpacing: "0.05em", textTransform: "uppercase",
        }}>
          Nuevo archivo
        </button>
      )}
    </header>
  );
}

// ── Main App ───────────────────────────────────────────────────────
export default function DataPulse() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState("resumen");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showDupRows, setShowDupRows] = useState(false);
  const [catFilters, setCatFilters] = useState({});
  const [numFilters, setNumFilters] = useState({});
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
      parsed.headers.forEach((h, i) => { if (types[i] === "numeric" && statsMap[h]) initNum[h] = [statsMap[h].min, statsMap[h].max]; });
      setCatFilters(initCat);
      setNumFilters(initNum);
      setExplorerX(numericCols[0] || "");
      setExplorerY(numericCols[1] || numericCols[0] || "");
      setAnalysis({ types, statsMap, correlations, catBreakdowns, insights: generateInsights(parsed.headers, parsed.rows, types, statsMap, correlations) });
      setActiveTab("resumen");
    };
    reader.readAsText(file);
  }, []);

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

  const onDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }, [handleFile]);

  const handleReset = () => { setData(null); setAnalysis(null); setFileName(""); setCatFilters({}); setNumFilters({}); };

  const handleExportCSV = useCallback(() => {
    const escape = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      headers.map(escape).join(","),
      ...filteredRows.map(r => r.map(escape).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const dot = fileName.lastIndexOf(".");
    const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot >= 0 ? fileName.slice(dot) : ".csv";
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}_filtrado${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [headers, filteredRows, fileName]);

  // ── Upload screen ─────────────────────────────────────────────
  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", fontFamily: "'Geist', system-ui, sans-serif", color: T.fg }}>
        {/* Sidebar stub */}
        <aside style={{ width: 56, background: T.bg1, borderRight: `1px solid ${T.line2}`, display: "flex", flexDirection: "column", alignItems: "center", padding: "16px 0", gap: 8 }}>
          <div style={{ width: 28, height: 28, border: `1px solid ${T.accent}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 10, height: 10, background: T.accent }} />
          </div>
        </aside>

        {/* Main upload area */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div style={{ maxWidth: 560, width: "100%" }}>
            {/* Grid bg decoration */}
            <div style={{ position: "relative" }}>
              <div style={{ textAlign: "center", marginBottom: 40 }}>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 10,
                  border: `1px solid ${T.accentLine}`, background: T.accentDim,
                  padding: "4px 12px", marginBottom: 32,
                }}>
                  <span style={{ ...mono, fontSize: 10, color: T.accent, letterSpacing: "0.1em" }}>v 2.4 · DATAPULSE</span>
                </div>
                <h1 style={{ fontSize: 52, fontWeight: 600, letterSpacing: "-0.03em", margin: "0 0 8px", lineHeight: 1.05, color: T.fg }}>
                  Tu CSV.<br />
                  <span style={{ color: T.accent }}>Con respuestas.</span>
                </h1>
                <p style={{ color: T.fg3, fontSize: 15, margin: "16px 0 0", lineHeight: 1.6 }}>
                  Sube tu archivo y obtén estadísticas, gráficas interactivas y filtros en segundos.
                </p>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? T.accent : T.line2}`,
                  padding: "52px 32px", cursor: "pointer", textAlign: "center",
                  background: dragOver ? T.accentDim : T.bg1,
                  transition: "all 0.15s", position: "relative",
                }}
              >
                {/* Grid decoration */}
                <div style={{
                  position: "absolute", inset: 0, opacity: 0.3, pointerEvents: "none",
                  backgroundImage: `linear-gradient(to right, ${T.line} 1px, transparent 1px), linear-gradient(to bottom, ${T.line} 1px, transparent 1px)`,
                  backgroundSize: "48px 48px",
                }} />
                <div style={{ position: "relative" }}>
                  <div style={{ fontSize: 40, marginBottom: 12, color: T.accent }}>↓</div>
                  <p style={{ color: T.fg, fontSize: 16, margin: "0 0 6px", fontWeight: 500 }}>Arrastra tu CSV aquí</p>
                  <p style={{ color: T.fg4, fontSize: 13, margin: "0 0 20px" }}>o haz clic para seleccionar archivo</p>
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: 8,
                    border: `1px solid ${T.accent}`, background: T.accentDim,
                    color: T.accent, padding: "8px 20px",
                    ...mono, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
                  }}>
                    SELECCIONAR ARCHIVO
                  </div>
                </div>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
              </div>

              {/* Footer note */}
              <div style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ ...mono, fontSize: 11, color: T.fg4 }}>🔒 Procesado localmente · No se envía a ningún servidor</div>
                <div style={{ ...mono, fontSize: 11, color: T.fg4 }}>CSV con , o ;</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── App shell (with data) ──────────────────────────────────────
  const { headers, rows } = data;
  const { types, statsMap, correlations, catBreakdowns, insights } = analysis;
  const numericCols = headers.filter((_, i) => types[i] === "numeric");
  const catCols = headers.filter((_, i) => types[i] === "categorical");

  // ── Cleaning analysis ──────────────────────────────────────────
  const nullAnalysis = headers.map((h, i) => {
    const vals = rows.map(r => r[i]);
    const nullCount = vals.filter(v => v === "" || v == null).length;
    const pct = nullCount / rows.length * 100;
    return { col: h, nullCount, pct, type: types[i] };
  }).sort((a, b) => b.nullCount - a.nullCount);
  const colsWithNulls = nullAnalysis.filter(x => x.nullCount > 0);

  const rowKeys = rows.map(r => r.join("\x00"));
  const _dupSeen = new Set();
  const dupIndices = [];
  rowKeys.forEach((k, i) => { if (_dupSeen.has(k)) dupIndices.push(i); else _dupSeen.add(k); });
  const dupCount = dupIndices.length;
  const dupSample = dupIndices.slice(0, 50).map(i => rows[i]);

  const inconsistentCols = headers.map((h, i) => {
    const vals = rows.map(r => r[i]).filter(v => v !== "" && v != null);
    if (vals.length === 0) return null;
    const numCount = vals.filter(v => !isNaN(Number(v.toString().replace(",", ".")))).length;
    const textCount = vals.length - numCount;
    if (numCount > 0 && textCount > 0 && Math.min(numCount, textCount) / vals.length > 0.02)
      return { col: h, numCount, textCount, total: vals.length, detectedType: types[i] };
    return null;
  }).filter(Boolean);

  const cleaningIssues = colsWithNulls.length + (dupCount > 0 ? 1 : 0) + inconsistentCols.length;

  const activeFiltersCount = Object.entries(catFilters).reduce((acc, [col, s]) => {
    const allVals = [...new Set(rows.map(r => r[headers.indexOf(col)]).filter(Boolean))];
    return acc + (s.size < allVals.length ? 1 : 0);
  }, 0) + Object.entries(numFilters).reduce((acc, [col, [mn, mx]]) => {
    const s = statsMap[col]; return acc + (s && (mn > s.min || mx < s.max) ? 1 : 0);
  }, 0);

  const card = { background: T.bg1, border: `1px solid ${T.line2}`, padding: 20, marginBottom: 16 };

  return (
    <div style={{ display: "flex", height: "100vh", background: T.bg, fontFamily: "'Geist', system-ui, sans-serif", color: T.fg, overflow: "hidden" }}>
      <Sidebar
        active={activeTab}
        onNav={setActiveTab}
        collapsed={sidebarCollapsed}
        fileName={fileName}
        rowCount={filteredRows.length}
        colCount={headers.length}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
        <Topbar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(v => !v)}
          activeTab={activeTab}
          fileName={fileName}
          onReset={handleReset}
        />

        {/* KPI strip */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.line2}`, flexShrink: 0 }}>
          {[
            { label: "Filas", value: `${filteredRows.length.toLocaleString()} / ${rows.length.toLocaleString()}`, color: T.accent },
            { label: "Columnas", value: headers.length, color: T.accent },
            { label: "Numéricas", value: numericCols.length, color: T.amber },
            { label: "Categóricas", value: catCols.length, color: T.amber },
            ...(activeFiltersCount > 0 ? [{ label: "Filtros activos", value: activeFiltersCount, color: T.amber }] : []),
          ].map((kpi, i) => (
            <div key={i} style={{
              flex: "1 1 0", padding: "12px 20px",
              borderLeft: i > 0 ? `1px solid ${T.line2}` : "none",
              borderLeft: `3px solid ${i < 2 ? T.accentLine : "rgba(245,166,35,0.4)"}`,
            }}>
              <div style={{ ...label, marginBottom: 4 }}>{kpi.label}</div>
              <div style={{ ...mono, fontSize: 22, fontWeight: 600, color: kpi.color }}>{kpi.value}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.line2}`, overflowX: "auto", flexShrink: 0, background: T.bg1 }}>
          {NAV_ITEMS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              background: "transparent",
              borderBottom: activeTab === t.id ? `2px solid ${T.accent}` : "2px solid transparent",
              borderTop: "none", borderLeft: "none", borderRight: "none",
              color: activeTab === t.id ? T.accent : T.fg4,
              padding: "12px 20px", cursor: "pointer",
              ...mono, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase",
              whiteSpace: "nowrap", transition: "all 0.15s",
              background: activeTab === t.id ? T.accentDim : "transparent",
            }}>
              {t.icon} {t.label}
              {t.id === "filtros" && activeFiltersCount > 0 && (
                <span style={{ marginLeft: 6, background: T.amber, color: T.bg, fontSize: 9, padding: "1px 5px", ...mono }}>
                  {activeFiltersCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 60px" }}>

          {/* ── RESUMEN ── */}
          {activeTab === "resumen" && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={label}>RESUMEN DEL DATASET</div>
                <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, color: T.fg }}>{fileName}</div>
              </div>
              {numericCols.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
                  {numericCols.map(col => {
                    const s = statsMap[col];
                    const idx = headers.indexOf(col);
                    const lineData = filteredRows.slice(0, 80).map((r, i) => ({ i, v: toNum(r[idx]) })).filter(d => !isNaN(d.v));
                    return (
                      <div key={col} style={card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.accent }}>🔢 {col}</span>
                          <span style={{ ...mono, fontSize: 9, color: T.fg4, border: `1px solid ${T.line2}`, padding: "2px 7px" }}>NUMÉRICA</span>
                        </div>
                        <ResponsiveContainer width="100%" height={70}>
                          <LineChart data={lineData}>
                            <Line type="monotone" dataKey="v" stroke={T.accent} strokeWidth={1.5} dot={false} />
                            <Tooltip content={<CustomTooltip />} />
                            <ReferenceLine y={s?.mean} stroke={T.amber} strokeDasharray="3 3" strokeWidth={1} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 12, borderTop: `1px solid ${T.line}`, paddingTop: 10 }}>
                          {[["Media", fmt(s?.mean)], ["Mediana", fmt(s?.median)], ["Desv.", fmt(s?.std)],
                            ["Mín", fmt(s?.min)], ["Máx", fmt(s?.max)], ["Outliers", s?.outliers ?? "—"]].map(([l, v], i) => (
                            <div key={i}>
                              <div style={{ ...mono, fontSize: 9, color: T.fg4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{l}</div>
                              <div style={{ ...mono, fontSize: 13, color: T.fg, fontWeight: 600 }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {catCols.length > 0 && (
                <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
                  {catCols.map(col => {
                    const idx = headers.indexOf(col);
                    const counts = {};
                    filteredRows.forEach(r => { const v = r[idx]; if (v) counts[v] = (counts[v] || 0) + 1; });
                    const chartData = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }));
                    return (
                      <div key={col} style={card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.amber }}>🏷️ {col}</span>
                          <span style={{ ...mono, fontSize: 9, color: T.fg4, border: `1px solid ${T.line2}`, padding: "2px 7px" }}>CATEGÓRICA</span>
                        </div>
                        <ResponsiveContainer width="100%" height={150}>
                          <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 30 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={T.line2} />
                            <XAxis dataKey="label" tick={{ fill: T.fg4, fontSize: 10, fontFamily: "monospace" }} angle={-35} textAnchor="end" interval={0} />
                            <YAxis tick={{ fill: T.fg4, fontSize: 10, fontFamily: "monospace" }} />
                            <Tooltip content={<CustomTooltip />} />
                            <Bar dataKey="value" radius={0}>
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
              <div style={{ marginBottom: 20 }}>
                <div style={label}>EXPLORADOR DE VARIABLES</div>
                <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>Selecciona variables para cruzarlas y visualizarlas.</p>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                {[
                  { lbl: "EJE X / VARIABLE", val: explorerX, set: setExplorerX, opts: headers },
                  { lbl: "EJE Y / MÉTRICA", val: explorerY, set: setExplorerY, opts: ["", ...numericCols] },
                ].map(({ lbl, val, set, opts }) => (
                  <div key={lbl}>
                    <div style={{ ...label, marginBottom: 6 }}>{lbl}</div>
                    <select value={val} onChange={e => set(e.target.value)} style={{
                      background: T.bg1, border: `1px solid ${T.line2}`, color: T.fg,
                      padding: "8px 12px", fontSize: 12, ...mono, cursor: "pointer",
                    }}>
                      {opts.map(h => <option key={h} value={h}>{h || "— conteo —"}</option>)}
                    </select>
                  </div>
                ))}
                <div>
                  <div style={{ ...label, marginBottom: 6 }}>TIPO DE GRÁFICA</div>
                  <div style={{ display: "flex", border: `1px solid ${T.line2}` }}>
                    {["bar", "line", "scatter"].map(type => (
                      <button key={type} onClick={() => setExplorerType(type)} style={{
                        padding: "8px 14px", ...mono, fontSize: 11, textTransform: "uppercase",
                        background: explorerType === type ? T.accentDim : "transparent",
                        border: "none", borderLeft: type !== "bar" ? `1px solid ${T.line2}` : "none",
                        color: explorerType === type ? T.accent : T.fg3,
                        cursor: "pointer",
                      }}>
                        {type}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={card}>
                <div style={{ marginBottom: 12, fontSize: 13, color: T.fg2 }}>
                  <strong style={{ color: T.fg }}>{explorerX}</strong>
                  {explorerY && <> vs <strong style={{ color: T.accent }}>{explorerY}</strong></>}
                  <span style={{ color: T.fg4, ...mono, fontSize: 11, marginLeft: 10 }}>({filteredRows.length.toLocaleString()} registros)</span>
                </div>
                {explorerType === "scatter" && numericCols.includes(explorerX) ? (
                  <ResponsiveContainer width="100%" height={360}>
                    <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.line2} />
                      <XAxis dataKey="x" tick={{ fill: T.fg4, fontSize: 11, fontFamily: "monospace" }} />
                      <YAxis dataKey="y" tick={{ fill: T.fg4, fontSize: 11, fontFamily: "monospace" }} />
                      <Tooltip content={<ScatterTooltip />} />
                      <Scatter data={explorerData} fill={T.accent} fillOpacity={0.7} />
                    </ScatterChart>
                  </ResponsiveContainer>
                ) : explorerType === "line" ? (
                  <ResponsiveContainer width="100%" height={360}>
                    <LineChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.line2} />
                      <XAxis dataKey="label" tick={{ fill: T.fg4, fontSize: 10, fontFamily: "monospace" }} angle={-35} textAnchor="end" interval="preserveStartEnd" />
                      <YAxis tick={{ fill: T.fg4, fontSize: 11, fontFamily: "monospace" }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="value" stroke={T.accent} strokeWidth={1.75} dot={{ fill: T.accent, r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={360}>
                    <BarChart data={explorerData} margin={{ top: 10, right: 20, bottom: 40, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={T.line2} />
                      <XAxis dataKey="label" tick={{ fill: T.fg4, fontSize: 10, fontFamily: "monospace" }} angle={-35} textAnchor="end" interval={0} />
                      <YAxis tick={{ fill: T.fg4, fontSize: 11, fontFamily: "monospace" }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="value" radius={0}>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                <div>
                  <div style={label}>FILTROS</div>
                  <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>
                    Mostrando <strong style={{ color: T.accent }}>{filteredRows.length.toLocaleString()}</strong> de {rows.length.toLocaleString()} filas
                  </p>
                </div>
                <button onClick={() => {
                  const initCat = {};
                  headers.forEach((h, i) => { if (types[i] === "categorical") initCat[h] = new Set([...new Set(rows.map(r => r[i]).filter(Boolean))]); });
                  const initNum = {};
                  headers.forEach((h, i) => { if (types[i] === "numeric" && statsMap[h]) initNum[h] = [statsMap[h].min, statsMap[h].max]; });
                  setCatFilters(initCat); setNumFilters(initNum);
                }} style={{
                  ...mono, fontSize: 11, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                  color: "#FCA5A5", padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.05em",
                }}>
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
                      <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.amber }}>🏷️ {col}</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set(allVals) }))}
                          style={{ ...mono, fontSize: 10, color: T.accent, background: "none", border: "none", cursor: "pointer", textTransform: "uppercase" }}>Todo</button>
                        <button onClick={() => setCatFilters(p => ({ ...p, [col]: new Set() }))}
                          style={{ ...mono, fontSize: 10, color: T.fg4, background: "none", border: "none", cursor: "pointer", textTransform: "uppercase" }}>Ninguno</button>
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
                            padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                            border: `1px solid ${active ? T.accentLine : T.line2}`,
                            background: active ? T.accentDim : "transparent",
                            color: active ? T.accent : T.fg4, transition: "all 0.15s", ...mono,
                          }}>
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
                      <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.accent }}>🔢 {col}</span>
                      <span style={{ ...mono, fontSize: 11, color: T.fg3 }}>{fmt(mn)} — {fmt(mx)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 16 }}>
                      {[["Mínimo", mn, v => setNumFilters(p => ({ ...p, [col]: [parseFloat(v), mx] }))],
                        ["Máximo", mx, v => setNumFilters(p => ({ ...p, [col]: [mn, parseFloat(v)] }))]].map(([lbl, val, handler]) => (
                        <div key={lbl} style={{ flex: 1 }}>
                          <div style={{ ...label, marginBottom: 6 }}>{lbl}</div>
                          <input type="range" min={s.min} max={s.max} step={(s.max - s.min) / 100} value={val}
                            onChange={e => handler(e.target.value)}
                            style={{ width: "100%", accentColor: T.accent }} />
                        </div>
                      ))}
                    </div>
                    <div style={{ ...mono, fontSize: 10, color: T.fg4, marginTop: 6 }}>Rango: {fmt(s.min)} — {fmt(s.max)}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── CORRELACIONES ── */}
          {activeTab === "correlaciones" && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={label}>MATRIZ DE CORRELACIONES</div>
                <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>Valores entre -1 (inversa perfecta) y +1 (directa perfecta).</p>
              </div>
              {numericCols.length < 2 ? (
                <div style={card}><p style={{ color: T.fg3, fontSize: 13 }}>Se necesitan al menos 2 columnas numéricas.</p></div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ padding: 8 }}></th>
                        {numericCols.map(c => (
                          <th key={c} style={{ padding: 8, ...mono, color: T.fg3, fontWeight: 600, maxWidth: 80, whiteSpace: "nowrap" }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {numericCols.map(a => (
                        <tr key={a}>
                          <td style={{ padding: 8, fontWeight: 600, color: T.fg2, whiteSpace: "nowrap", ...mono }}>{a}</td>
                          {numericCols.map(b => {
                            if (a === b) return <td key={b} style={{ padding: 8, textAlign: "center", color: T.fg4, ...mono }}>1.00</td>;
                            const c = correlations.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
                            const r = c ? c.r : null;
                            const abs = r != null ? Math.abs(r) : 0;
                            const bg = abs > 0.7 ? (r > 0 ? "rgba(0,212,255,0.2)" : "rgba(245,166,35,0.2)") : abs > 0.4 ? "rgba(255,255,255,0.05)" : "transparent";
                            return (
                              <td key={b} style={{ padding: 8, textAlign: "center", background: bg, color: T.fg, fontWeight: abs > 0.7 ? 700 : 400, ...mono }}>
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
              <div style={{ marginBottom: 20 }}>
                <div style={label}>INSIGHTS AUTOMÁTICOS</div>
                <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>Hallazgos detectados automáticamente en tus datos.</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {insights.map((ins, i) => {
                  const colors = {
                    warning: { bg: "rgba(245,166,35,0.08)", border: "rgba(245,166,35,0.3)", dot: T.amber },
                    info:    { bg: "rgba(0,212,255,0.06)",  border: "rgba(0,212,255,0.25)",  dot: T.accent },
                    success: { bg: "rgba(0,212,255,0.06)",  border: "rgba(0,212,255,0.25)",  dot: T.accent },
                  };
                  const c = colors[ins.type] || colors.info;
                  return (
                    <div key={i} style={{ padding: "14px 16px", background: c.bg, border: `1px solid ${c.border}`, fontSize: 13, lineHeight: 1.6, color: T.fg, display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{ins.icon}</span>
                      <span>{ins.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── LIMPIEZA ── */}
          {activeTab === "limpieza" && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={label}>ANÁLISIS DE CALIDAD DE DATOS</div>
                <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>
                  {cleaningIssues === 0
                    ? "No se detectaron problemas de calidad en el dataset."
                    : `${cleaningIssues} tipo${cleaningIssues !== 1 ? "s" : ""} de problema${cleaningIssues !== 1 ? "s" : ""} detectado${cleaningIssues !== 1 ? "s" : ""}.`}
                </p>
              </div>

              {/* KPI chips */}
              <div style={{ display: "flex", gap: 10, marginBottom: 28, flexWrap: "wrap" }}>
                {[
                  { label: "Cols. con nulos",      value: colsWithNulls.length,    amber: colsWithNulls.length > 0 },
                  { label: "Filas duplicadas",      value: dupCount,                amber: dupCount > 0 },
                  { label: "Tipos inconsistentes",  value: inconsistentCols.length, amber: inconsistentCols.length > 0 },
                ].map((chip, i) => {
                  const clr = chip.amber ? T.amber : T.accent;
                  return (
                    <div key={i} style={{
                      border: `1px solid ${chip.amber ? "rgba(245,166,35,0.3)" : "rgba(0,212,255,0.25)"}`,
                      background: chip.amber ? T.amberDim : T.accentDim,
                      padding: "10px 18px",
                    }}>
                      <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: clr }}>{chip.value.toLocaleString()}</div>
                      <div style={{ ...label, marginTop: 2, color: T.fg3 }}>{chip.label}</div>
                    </div>
                  );
                })}
              </div>

              {/* ── Sección 1: Nulos ── */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 3, height: 16, background: T.amber, flexShrink: 0 }} />
                  <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.fg, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Valores nulos por columna
                  </span>
                  <span style={{ ...mono, fontSize: 10, color: T.fg4 }}>({colsWithNulls.length}/{headers.length} columnas afectadas)</span>
                </div>
                {colsWithNulls.length === 0 ? (
                  <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: T.accent, fontSize: 15, flexShrink: 0 }}>✓</span>
                    <span style={{ ...mono, fontSize: 13, color: T.fg3 }}>Ninguna columna tiene valores vacíos.</span>
                  </div>
                ) : (
                  <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: T.bg2 }}>
                          {["Columna", "Tipo", "Nulos", "% total", "Severidad", "Sugerencia de acción"].map(h => (
                            <th key={h} style={{ ...label, padding: "10px 14px", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {nullAnalysis.map(({ col, nullCount, pct, type }) => {
                          const sevColor = pct > 30 ? "#EF4444" : pct > 10 ? T.amber : T.accent;
                          const severity = pct > 30 ? "ALTA" : pct > 10 ? "MEDIA" : "BAJA";
                          const suggestion = nullCount === 0
                            ? "Sin nulos"
                            : type === "numeric"
                              ? pct > 30 ? "Evaluar eliminar columna" : "Imputar con media o mediana"
                              : pct > 30 ? "Evaluar eliminar columna" : "Imputar con moda o 'Desconocido'";
                          return (
                            <tr key={col} style={{ borderTop: `1px solid ${T.line}`, background: nullCount > 0 ? "rgba(245,166,35,0.02)" : "transparent" }}>
                              <td style={{ padding: "9px 14px", ...mono, fontSize: 12, color: nullCount > 0 ? T.fg : T.fg3, fontWeight: nullCount > 0 ? 600 : 400 }}>{col}</td>
                              <td style={{ padding: "9px 14px", ...mono, fontSize: 10, color: T.fg4, textTransform: "uppercase" }}>{type}</td>
                              <td style={{ padding: "9px 14px", ...mono, fontSize: 13, color: nullCount > 0 ? sevColor : T.fg4, fontWeight: nullCount > 0 ? 700 : 400 }}>
                                {nullCount.toLocaleString()}
                              </td>
                              <td style={{ padding: "9px 14px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div style={{ width: 56, height: 4, background: T.bg3, flexShrink: 0 }}>
                                    <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: nullCount > 0 ? sevColor : T.bg3 }} />
                                  </div>
                                  <span style={{ ...mono, fontSize: 11, color: nullCount > 0 ? sevColor : T.fg4 }}>{pct.toFixed(1)}%</span>
                                </div>
                              </td>
                              <td style={{ padding: "9px 14px" }}>
                                {nullCount > 0 && (
                                  <span style={{ ...mono, fontSize: 9, color: sevColor, border: `1px solid ${sevColor}`, padding: "2px 6px" }}>{severity}</span>
                                )}
                              </td>
                              <td style={{ padding: "9px 14px", ...mono, fontSize: 11, color: T.fg3 }}>{suggestion}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Sección 2: Duplicados ── */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 3, height: 16, background: T.amber, flexShrink: 0 }} />
                  <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.fg, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Filas duplicadas
                  </span>
                </div>
                <div style={card}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <span style={{ ...mono, fontSize: 26, fontWeight: 700, color: dupCount > 0 ? T.amber : T.accent }}>{dupCount.toLocaleString()}</span>
                      <div>
                        <div style={{ ...mono, fontSize: 12, color: T.fg }}>
                          {dupCount === 0 ? "Sin filas duplicadas." : `fila${dupCount !== 1 ? "s" : ""} duplicada${dupCount !== 1 ? "s" : ""} detectada${dupCount !== 1 ? "s" : ""}`}
                        </div>
                        {dupCount > 0 && (
                          <div style={{ ...mono, fontSize: 11, color: T.fg4, marginTop: 3 }}>
                            {(dupCount / rows.length * 100).toFixed(1)}% del total ·{" "}
                            <span style={{ color: T.amber }}>Sugerencia: deduplica antes de analizar</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {dupCount > 0 && (
                      <button onClick={() => setShowDupRows(v => !v)} style={{
                        ...mono, fontSize: 11,
                        background: showDupRows ? T.amberDim : "transparent",
                        border: `1px solid rgba(245,166,35,0.35)`,
                        color: T.amber, padding: "6px 16px",
                        cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.05em",
                      }}>
                        {showDupRows ? "Ocultar filas" : "Ver filas"}
                      </button>
                    )}
                  </div>
                  {dupCount > 0 && showDupRows && (
                    <div style={{ marginTop: 16, borderTop: `1px solid ${T.line2}`, paddingTop: 14 }}>
                      <div style={{ ...mono, fontSize: 10, color: T.fg4, marginBottom: 10 }}>
                        Mostrando {Math.min(50, dupCount)} de {dupCount.toLocaleString()} filas duplicadas
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                          <thead>
                            <tr style={{ background: T.bg2 }}>
                              {headers.map(h => (
                                <th key={h} style={{ ...label, padding: "6px 12px", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {dupSample.map((row, ri) => (
                              <tr key={ri} style={{ borderTop: `1px solid ${T.line}`, background: "rgba(245,166,35,0.03)" }}>
                                {row.map((v, ci) => (
                                  <td key={ci} style={{ padding: "5px 12px", color: T.fg3, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...mono }}>{v || "—"}</td>
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

              {/* ── Sección 3: Tipos inconsistentes ── */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 3, height: 16, background: T.amber, flexShrink: 0 }} />
                  <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.fg, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Columnas con tipos inconsistentes
                  </span>
                  <span style={{ ...mono, fontSize: 10, color: T.fg4 }}>({inconsistentCols.length} detectadas)</span>
                </div>
                {inconsistentCols.length === 0 ? (
                  <div style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: T.accent, fontSize: 15, flexShrink: 0 }}>✓</span>
                    <span style={{ ...mono, fontSize: 13, color: T.fg3 }}>Todos los tipos de columna son consistentes.</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {inconsistentCols.map(({ col, numCount, textCount, total, detectedType }) => {
                      const numPct = (numCount / total * 100).toFixed(1);
                      const textPct = (textCount / total * 100).toFixed(1);
                      const suggestion = numCount > textCount
                        ? `Columna mayoritariamente numérica. Limpiar o marcar como nulos los ${textCount.toLocaleString()} valor${textCount !== 1 ? "es" : ""} no numérico${textCount !== 1 ? "s" : ""}.`
                        : `Columna mayoritariamente textual. Verificar si los ${numCount.toLocaleString()} valor${numCount !== 1 ? "es" : ""} numérico${numCount !== 1 ? "s" : ""} son errores de entrada.`;
                      return (
                        <div key={col} style={{ ...card, marginBottom: 0 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
                            <div>
                              <div style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.amber, marginBottom: 10 }}>{col}</div>
                              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                                <div>
                                  <div style={{ ...label, marginBottom: 4 }}>Valores numéricos</div>
                                  <div style={{ ...mono, fontSize: 15, color: T.accent, fontWeight: 700 }}>
                                    {numCount.toLocaleString()} <span style={{ fontSize: 10, color: T.fg4, fontWeight: 400 }}>({numPct}%)</span>
                                  </div>
                                </div>
                                <div>
                                  <div style={{ ...label, marginBottom: 4 }}>Valores texto</div>
                                  <div style={{ ...mono, fontSize: 15, color: T.amber, fontWeight: 700 }}>
                                    {textCount.toLocaleString()} <span style={{ fontSize: 10, color: T.fg4, fontWeight: 400 }}>({textPct}%)</span>
                                  </div>
                                </div>
                                <div>
                                  <div style={{ ...label, marginBottom: 4 }}>Tipo detectado</div>
                                  <span style={{ ...mono, fontSize: 10, color: T.fg4, border: `1px solid ${T.line2}`, padding: "2px 7px" }}>{detectedType.toUpperCase()}</span>
                                </div>
                              </div>
                            </div>
                            <div style={{ maxWidth: 300 }}>
                              <div style={{ ...label, marginBottom: 6 }}>Sugerencia de acción</div>
                              <div style={{ fontSize: 12, color: T.fg3, lineHeight: 1.65 }}>{suggestion}</div>
                            </div>
                          </div>
                          <div style={{ marginTop: 14, display: "flex", height: 5, gap: 2 }}>
                            <div style={{ background: T.accent, flex: numCount }} title={`Numérico: ${numPct}%`} />
                            <div style={{ background: T.amber, flex: textCount }} title={`Texto: ${textPct}%`} />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                            <span style={{ ...mono, fontSize: 9, color: T.accent }}>▬ numérico ({numPct}%)</span>
                            <span style={{ ...mono, fontSize: 9, color: T.amber }}>▬ texto ({textPct}%)</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── All clear ── */}
              {cleaningIssues === 0 && (
                <div style={{ ...card, textAlign: "center", padding: "40px 20px" }}>
                  <div style={{ fontSize: 30, marginBottom: 12, color: T.accent }}>✓</div>
                  <div style={{ ...mono, fontSize: 15, fontWeight: 600, color: T.fg, marginBottom: 6 }}>Dataset limpio</div>
                  <div style={{ fontSize: 13, color: T.fg3 }}>No se detectaron nulos, duplicados ni tipos mezclados.</div>
                </div>
              )}
            </div>
          )}

          {/* ── DATOS ── */}
          {activeTab === "datos" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                <div>
                  <div style={label}>VISTA DE DATOS</div>
                  <p style={{ color: T.fg3, fontSize: 13, margin: "6px 0 0" }}>
                    Mostrando {Math.min(100, filteredRows.length)} de {filteredRows.length.toLocaleString()} filas filtradas.
                  </p>
                </div>
                <button onClick={handleExportCSV} style={{
                  ...mono, fontSize: 11, background: T.accentDim,
                  border: `1px solid ${T.accentLine}`, color: T.accent,
                  padding: "7px 16px", cursor: "pointer", fontFamily: "inherit",
                  letterSpacing: "0.06em", textTransform: "uppercase",
                  transition: "background 0.15s, border-color 0.15s",
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,212,255,0.2)"; e.currentTarget.style.borderColor = T.accent; }}
                  onMouseLeave={e => { e.currentTarget.style.background = T.accentDim; e.currentTarget.style.borderColor = T.accentLine; }}
                >
                  ↓ Exportar CSV
                </button>
              </div>
              <div style={{ overflowX: "auto", border: `1px solid ${T.line2}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: T.bg2 }}>
                      <th style={{ padding: "8px 10px", color: T.fg4, textAlign: "center", ...mono, fontSize: 10 }}>#</th>
                      {headers.map(h => (
                        <th key={h} style={{ padding: "8px 12px", color: T.fg4, textAlign: "left", whiteSpace: "nowrap", ...mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.slice(0, 100).map((r, ri) => (
                      <tr key={ri} style={{ borderTop: `1px solid ${T.line}` }}
                        onMouseEnter={e => e.currentTarget.style.background = T.bg1}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                      >
                        <td style={{ padding: "6px 10px", color: T.fg4, textAlign: "center", ...mono }}>{ri + 1}</td>
                        {r.map((v, ci) => (
                          <td key={ci} style={{ padding: "6px 12px", color: T.fg2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</td>
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
    </div>
  );
}