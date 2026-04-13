// Sankey rendering for the chip pipeline dashboard.
// Fetches data.json (produced by sync/sheet_to_json.py) at startup.
// Re-renders on year / view / aggregate changes.

let PIPELINE_DATA = null;

const state = {
  year: 2025,
  aggregateYears: false,
  view: "aggregate", // "aggregate" | "by_company"
};

// Stage-level (aggregate) colors.
const STAGE_COLORS = {
  us_prod: "#2f6fd8",
  us_own:  "#4d87e0",
  us_use:  "#6b9fe8",
  cn_prod: "#d63b3b",
  cn_own:  "#e05858",
  cn_use:  "#e87575",
};

// Per-company palette (by entity name as it appears in data.json).
// Designers and owners share color by entity so Google-prod connects visually
// to Google-own.
const COMPANY_COLORS = {
  // US/RoW designers — blues
  "NVIDIA":   "#1a4fb0",
  "Nvidia":   "#1a4fb0",
  "Google":   "#2f6fd8",
  "AMD":      "#4d87e0",
  "Amazon":   "#6b9fe8",
  "Intel":    "#a8c2ee",
  // US/RoW owners — distinct mid-blues
  "Microsoft": "#3d7fc5",
  "Meta":      "#8ab4f0",
  "Oracle":    "#5a95d5",
  "xAI":       "#7aabdf",
  // China — reds
  "Huawei":    "#b02727",
  "China":     "#c84040",
  "Cambricon": "#d63b3b",
  "Alibaba T-Head": "#e05858",
  "Alibaba":   "#e05858",
  "Baidu":     "#e87575",
  "Moore Threads": "#ed9898",
};

// Grey for catch-all / residual nodes so named entities stand out.
const OTHER_UNKNOWN_COLOR = "#999";

function isOtherUnknown(n) {
  const id = (n.id || "").toLowerCase();
  return id.includes("other") || id.includes("unknown");
}

function nodeColor(n) {
  if (isOtherUnknown(n)) return OTHER_UNKNOWN_COLOR;
  if (n.entity && COMPANY_COLORS[n.entity]) return COMPANY_COLORS[n.entity];
  if (STAGE_COLORS[n.id]) return STAGE_COLORS[n.id];
  // Fallback by country
  return n.country === "us" ? "#6b9fe8" : "#e87575";
}

// Link colors by edge type. Cross-track edges get distinct colors;
// edges touching Other/Unknown nodes get grey.
function linkColor(edge, view) {
  const nodes = view.nodes;
  const sNode = nodes.find(n => n.id === edge.sourceId);
  const tNode = nodes.find(n => n.id === edge.targetId);
  if (!sNode || !tNode) return "#999";
  // Grey for edges flowing to/from residual "Other"/"Unknown" buckets.
  if (isOtherUnknown(sNode) || isOtherUnknown(tNode)) return OTHER_UNKNOWN_COLOR;
  if (sNode.country !== tNode.country) {
    const lbl = (edge.label || "").toLowerCase();
    if (lbl.includes("smuggl")) return "#e69138";
    if (lbl.includes("cloud"))  return "#8e7cc3";
    return "#6aa84f"; // legal imports
  }
  // Same-track: source node color, slightly lightened.
  return nodeColor(sNode);
}

function formatNumber(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return n.toString();
}

function getActiveView() {
  return PIPELINE_DATA.views[state.view];
}

function getEdgesForState() {
  const view = getActiveView();
  if (state.aggregateYears) {
    // Sum from earliest year up to (and including) the selected year.
    const agg = new Map();
    for (const y of PIPELINE_DATA.years) {
      if (y > state.year) continue;
      for (const e of view.edgesByYear[String(y)] || []) {
        const key = `${e.source}|${e.target}|${e.label || ""}`;
        if (!agg.has(key)) {
          agg.set(key, {
            source: e.source,
            target: e.target,
            value: 0,
            ci_low: 0,
            ci_high: 0,
            label: e.label,
            is_dummy: false,
          });
        }
        const a = agg.get(key);
        a.value += e.value;
        // CI bounds: if either edge is missing a bound, treat it as value.
        a.ci_low  += (e.ci_low  == null ? e.value : e.ci_low);
        a.ci_high += (e.ci_high == null ? e.value : e.ci_high);
        // If any year's version is dummy, the combined edge is dummy.
        if (e.is_dummy) a.is_dummy = true;
      }
    }
    return Array.from(agg.values());
  }
  return view.edgesByYear[String(state.year)] || [];
}

function render() {
  const svg = d3.select("#sankey");
  svg.selectAll("*").remove();

  // Taller SVG for by-company view (many user nodes in column 3).
  svg.node().style.height = (state.view === "by_company") ? "820px" : "560px";

  const width  = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const margin = { top: 20, right: 200, bottom: 30, left: 20 };

  const innerW = width  - margin.left - margin.right;
  const innerH = height - margin.top  - margin.bottom;

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const view = getActiveView();
  const edges = getEdgesForState();

  if (edges.length === 0) {
    g.append("text")
      .attr("x", innerW / 2)
      .attr("y", innerH / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#999")
      .text("No data for this year.");
    return;
  }

  // Only include nodes that actually appear in the current edge set.
  const activeNodeIds = new Set();
  edges.forEach(e => { activeNodeIds.add(e.source); activeNodeIds.add(e.target); });
  const nodes = view.nodes
    .filter(n => activeNodeIds.has(n.id))
    .map(n => ({ ...n }));

  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));

  // Sankey-compatible links
  const links = edges.map(e => ({
    source: nodeIndex.get(e.source),
    target: nodeIndex.get(e.target),
    sourceId: e.source,
    targetId: e.target,
    value: e.value,
    ci_low: e.ci_low,
    ci_high: e.ci_high,
    label: e.label,
    is_dummy: !!e.is_dummy,
  }));

  // A node is implicitly "dummy" (all its signal comes from placeholders) if
  // every edge touching it is a dummy edge. This lets us stripe terminal use
  // nodes and any all-forecast column without threading flags through the
  // sync script for every node.
  const nodeAllDummy = new Map(); // id → boolean
  for (const n of nodes) nodeAllDummy.set(n.id, { any: false, allDummy: true });
  for (const l of links) {
    for (const nid of [l.sourceId, l.targetId]) {
      const rec = nodeAllDummy.get(nid);
      if (!rec) continue;
      rec.any = true;
      if (!l.is_dummy) rec.allDummy = false;
    }
  }
  nodes.forEach(n => {
    const rec = nodeAllDummy.get(n.id);
    n.is_dummy = rec && rec.any && rec.allDummy;
  });

  const sankeyLayout = d3.sankey()
    .nodeWidth(18)
    .nodePadding(state.view === "by_company" ? 10 : 24)
    // Sort: (1) US/RoW at top, China at bottom; (2) within each country,
    // other/unknown buckets sink to the bottom of their group; (3) within
    // named entities, largest value first to reduce edge crossings.
    .nodeSort((a, b) => {
      const aCN = a.country === "cn" ? 1 : 0;
      const bCN = b.country === "cn" ? 1 : 0;
      if (aCN !== bCN) return aCN - bCN;
      // Within same country: push other/unknown to bottom
      const aOther = isOtherUnknown(a) ? 1 : 0;
      const bOther = isOtherUnknown(b) ? 1 : 0;
      if (aOther !== bOther) return aOther - bOther;
      // Named entities: largest value first (descending)
      return (b.value || 0) - (a.value || 0);
    })
    .extent([[0, 0], [innerW, innerH]]);

  const graph = sankeyLayout({
    nodes: nodes.map(d => Object.assign({}, d)),
    links: links.map(d => Object.assign({}, d)),
  });

  // ---------- SVG defs: diagonal-hatch pattern for dummy data ----------
  // Pattern paints white stripes at 45° over whatever fill/stroke sits
  // underneath, so links and nodes keep their colors and just get overlaid
  // with stripes to flag "this number is a placeholder / forecast / rough
  // estimate". Rendered once per render() call.
  const defs = svg.append("defs");
  const hatch = defs.append("pattern")
    .attr("id", "dummy-hatch")
    .attr("patternUnits", "userSpaceOnUse")
    .attr("width", 8)
    .attr("height", 8)
    .attr("patternTransform", "rotate(-45)");
  hatch.append("rect")
    .attr("width", 8).attr("height", 8)
    .attr("fill", "rgba(255,255,255,0)");
  hatch.append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", 3).attr("height", 8)
    .attr("fill", "rgba(255,255,255,0.7)");

  // No y-axis scale bar — every node label already shows its value.

  // Links first so nodes sit on top
  g.append("g")
    .selectAll("path")
    .data(graph.links)
    .join("path")
      .attr("class", "link")
      .attr("d", d3.sankeyLinkHorizontal())
      .attr("stroke", d => linkColor(d, view))
      .attr("stroke-width", d => Math.max(1, d.width))
      .on("mousemove", (event, d) => showTooltip(event, linkTooltipHTML(d, view)))
      .on("mouseleave", hideTooltip);

  // Dummy-link hatch overlay: same d, stroked with the hatch pattern. Sits
  // on top of the colored stroke so the color still shows but the stripes
  // clearly flag "this is a placeholder / forecast / rough estimate".
  g.append("g")
    .selectAll("path")
    .data(graph.links.filter(d => d.is_dummy))
    .join("path")
      .attr("class", "link-dummy-overlay")
      .attr("d", d3.sankeyLinkHorizontal())
      .attr("stroke", "url(#dummy-hatch)")
      .attr("stroke-width", d => Math.max(1, d.width))
      .attr("fill", "none")
      .style("pointer-events", "none");

  const nodeG = g.append("g")
    .selectAll("g")
    .data(graph.nodes)
    .join("g")
      .attr("class", "node");

  nodeG.append("rect")
    .attr("x", d => d.x0)
    .attr("y", d => d.y0)
    .attr("height", d => Math.max(1, d.y1 - d.y0))
    .attr("width", d => d.x1 - d.x0)
    .attr("fill", d => nodeColor(d))
    .on("click", (event, d) => {
      if (d.sheetUrl) window.open(d.sheetUrl, "_blank");
    })
    .on("mousemove", (event, d) => showTooltip(event, nodeTooltipHTML(d)))
    .on("mouseleave", hideTooltip);

  // Dummy-node hatch overlay: same rect stacked on top with the hatch
  // pattern as fill. Pointer events disabled so click/hover still hit the
  // colored rect beneath.
  nodeG.filter(d => d.is_dummy)
    .append("rect")
      .attr("class", "node-dummy-overlay")
      .attr("x", d => d.x0)
      .attr("y", d => d.y0)
      .attr("height", d => Math.max(1, d.y1 - d.y0))
      .attr("width", d => d.x1 - d.x0)
      .attr("fill", "url(#dummy-hatch)")
      .style("pointer-events", "none");

  nodeG.append("text")
    .attr("x", d => d.x0 < innerW / 2 ? d.x1 + 8 : d.x0 - 8)
    .attr("y", d => (d.y0 + d.y1) / 2)
    .attr("dy", "0.35em")
    .attr("text-anchor", d => d.x0 < innerW / 2 ? "start" : "end")
    .text(d => `${d.label} (${formatNumber(d.value)})`);
}

// ---------- Tooltip helpers ----------

const tooltipEl = () => document.getElementById("tooltip");

function showTooltip(event, html) {
  const el = tooltipEl();
  el.innerHTML = html;
  el.classList.remove("hidden");
  const rect = document.querySelector(".chart-wrap").getBoundingClientRect();
  el.style.left = (event.clientX - rect.left + 14) + "px";
  el.style.top  = (event.clientY - rect.top  + 14) + "px";
}

function hideTooltip() {
  tooltipEl().classList.add("hidden");
}

function ciSpan(d) {
  if (d.ci_low == null || d.ci_high == null) {
    return `<span class="ci-missing">80% CI: not set</span>`;
  }
  return `<span class="ci">80% CI: ${formatNumber(d.ci_low)}–${formatNumber(d.ci_high)}</span>`;
}

function dummyBadge() {
  return `<div class="sub ci-missing">⚠ placeholder / forecast — not a measured value</div>`;
}

function aggregateTimeframe() {
  const first = PIPELINE_DATA.years[0];
  return first < state.year ? `(${first}–${state.year})` : `(${state.year})`;
}

function nodeTooltipHTML(d) {
  const total = formatNumber(d.value);
  const timeframe = state.aggregateYears ? " " + aggregateTimeframe() : " (" + state.year + ")";
  return `
    <div class="value">${d.label}</div>
    <div class="sub">${total} H100e${timeframe}</div>
    ${d.is_dummy ? dummyBadge() : ""}
    <div class="sub">Click to open sheet tab.</div>
  `;
}

function linkTooltipHTML(d, view) {
  const sNode = view.nodes.find(n => n.id === d.sourceId);
  const tNode = view.nodes.find(n => n.id === d.targetId);
  const sLabel = sNode ? sNode.label : d.sourceId;
  const tLabel = tNode ? tNode.label : d.targetId;
  return `
    <div class="value">${sLabel} → ${tLabel}</div>
    <div class="sub">${formatNumber(d.value)} H100e${d.label ? " — " + d.label : ""}</div>
    <div class="sub">${ciSpan(d)}</div>
    ${d.is_dummy ? dummyBadge() : ""}
  `;
}

// ---------- Controls ----------

function setupControls() {
  const yearWrap = document.getElementById("year-selector");
  for (const y of PIPELINE_DATA.years) {
    const btn = document.createElement("button");
    btn.textContent = y;
    btn.dataset.year = y;
    if (y === state.year) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.year = y;
      updateYearButtons();
      render();
    });
    yearWrap.appendChild(btn);
  }

  document.getElementById("aggregate-toggle").addEventListener("change", (e) => {
    state.aggregateYears = e.target.checked;
    updateYearButtons();
    render();
  });

  // View toggle
  document.querySelectorAll("input[name='view-mode']").forEach(el => {
    el.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.view = e.target.value;
        render();
      }
    });
  });

  window.addEventListener("resize", render);
}

function updateYearButtons() {
  const btns = document.querySelectorAll("#year-selector button");
  btns.forEach(b => {
    const y = Number(b.dataset.year);
    if (state.aggregateYears) {
      // In aggregate mode: highlight all years up to selected, dim years after.
      b.classList.toggle("active", y <= state.year);
      b.disabled = false;
      b.style.opacity = y <= state.year ? "1" : "0.4";
    } else {
      b.classList.toggle("active", y === state.year);
      b.disabled = false;
      b.style.opacity = "1";
    }
  });
}

// ---------- Bootstrap ----------

function showLoadError(msg) {
  const svg = d3.select("#sankey");
  svg.selectAll("*").remove();
  svg.append("text")
    .attr("x", "50%")
    .attr("y", "50%")
    .attr("text-anchor", "middle")
    .attr("fill", "#c33")
    .text(msg);
}

fetch("data.json", { cache: "no-store" })
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(json => {
    PIPELINE_DATA = json;
    if (Array.isArray(json.years) && json.years.length) {
      state.year = json.years[json.years.length - 1];
    }
    setupControls();
    render();
  })
  .catch(err => {
    console.error("Failed to load data.json:", err);
    showLoadError("Failed to load data.json — run sync/sheet_to_json.py.");
  });
