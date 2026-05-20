const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Builds a compact statistical summary (~500 tokens max) from the analysis
 * produced by DataPulse. Only sends aggregated metrics — never the raw CSV.
 */
function buildDatasetSummary(headers, rows, types, statsMap, quality) {
  const fmt = (n) => {
    if (n == null || isNaN(n)) return null;
    return Math.abs(n) >= 1e6
      ? (n / 1e6).toFixed(2) + "M"
      : Math.abs(n) >= 1e3
      ? (n / 1e3).toFixed(1) + "K"
      : Number(n).toFixed(2).replace(/\.?0+$/, "");
  };

  // Numeric KPIs — top 5 columns by absolute max value (most "interesting")
  const numericStats = Object.entries(statsMap)
    .slice(0, 5)
    .map(([col, s]) => ({
      column: col,
      mean: fmt(s.mean),
      median: fmt(s.median),
      std: fmt(s.std),
      min: fmt(s.min),
      max: fmt(s.max),
      outliers: s.outliers,
      nulls: s.missing,
    }));

  // Categorical top-3 values per column (max 3 columns)
  const catSummary = headers
    .filter((_, i) => types[i] === "categorical")
    .slice(0, 3)
    .map((col) => {
      const idx = headers.indexOf(col);
      const counts = {};
      rows.forEach((r) => {
        const v = r[idx];
        if (v) counts[v] = (counts[v] || 0) + 1;
      });
      const top3 = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([val, n]) => `${val}(${((n / rows.length) * 100).toFixed(0)}%)`);
      return { column: col, top3 };
    });

  // Columns with most nulls
  const nullIssues = quality.nullDetails
    .slice(0, 5)
    .map(({ col, count, pct }) => ({
      column: col,
      nulls: count,
      pct: (pct * 100).toFixed(1) + "%",
    }));

  return {
    rows: rows.length,
    columns: headers.length,
    types: {
      numeric: headers.filter((_, i) => types[i] === "numeric").length,
      categorical: headers.filter((_, i) => types[i] === "categorical").length,
      date: headers.filter((_, i) => types[i] === "date").length,
    },
    quality: {
      score: quality.score,
      badge: quality.badge,
      duplicates: quality.duplicates,
      totalNulls: quality.totalNulls,
    },
    numericStats,
    categoricalSummary: catSummary,
    nullIssues,
  };
}

/**
 * Calls Gemini API with a compact dataset summary.
 * Returns the text response string.
 * Throws descriptive errors for missing key, quota, etc.
 */
export async function generateAIInsights(headers, rows, types, statsMap, quality) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  if (!apiKey || apiKey === "tu_api_key_aqui") {
    throw new Error("NO_API_KEY");
  }

  const summary = buildDatasetSummary(headers, rows, types, statsMap, quality);
  const summaryJSON = JSON.stringify(summary, null, 2);

  const prompt =
    "Eres un analista de datos. Analiza este dataset y da 5 insights concretos y accionables en español. Sé directo, usa bullets. Dataset: " +
    summaryJSON;

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const status = response.status;
    if (status === 400) throw new Error("API_KEY_INVALID");
    if (status === 429) throw new Error("QUOTA_EXCEEDED");
    if (status === 403) throw new Error("API_KEY_INVALID");
    throw new Error(`API_ERROR:${status}:${err?.error?.message || "unknown"}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("EMPTY_RESPONSE");
  return text;
}
