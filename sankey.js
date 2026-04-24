// Sankey rendering for the chip pipeline dashboard.
// Fetches data.json (produced by sync/sheet_to_json.py) at startup.
// Re-renders on year / view changes.

let PIPELINE_DATA = null;
// Map of year → chip_level payload. Sourced from chip_level_{year}.json in
// the new canonical-sheet sync (sync/sheet_to_chip_level.py).
let CHIP_LEVEL_BY_YEAR = {};
// Currently selected chip-level dataset (CHIP_LEVEL_BY_YEAR[state.year]).
let CHIP_LEVEL_DATA = null;

const state = {
  year: 2025,
  view: "by_company", // "aggregate" | "by_company" | "chip_level"
  showAll: false,     // when true and view === "by_company", swap in by_company_full
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
  if (state.view === "by_company" && state.showAll) {
    return PIPELINE_DATA.views.by_company_full;
  }
  return PIPELINE_DATA.views[state.view];
}

function getEdgesForState() {
  const view = getActiveView();
  return view.edgesByYear[String(state.year)] || [];
}

// Colors for each chip type in the chip-level view.
// Designed so NVIDIA generations trend warm (H=amber, B=red/purple),
// TPUs trend green, Amazon silicon trends orange, AMD trends teal.
const CHIP_TYPE_COLORS = {
  // NVIDIA
  "H100/H200":           "#e9a23b",
  "H100_H200_bundled":   "#e9a23b",
  "H100":                "#f0b454",
  "H200":                "#d68a24",
  "B200":                "#c4463a",
  "B300":                "#8e2e28",
  "GB200":               "#a03735",
  // Google TPU
  "TPU v5e":             "#a6d96a",
  "TPU v5p":             "#66bd63",
  "TPU v6e":             "#1a9850",
  "TPU v7":              "#006837",
  // Amazon
  "Trainium2":           "#f28e2c",
  "Trainium1":           "#ffb878",
  // AMD
  "Instinct MI300X":     "#1f77b4",
  "Instinct MI325X":     "#4392c2",
  "Instinct MI350X":     "#6baed6",
  "Instinct MI355X":     "#9ecae1",
  "MI300X":              "#1f77b4",
  "MI325X":              "#4392c2",
  "MI350X":              "#6baed6",
  "MI355X":              "#9ecae1",
  // CoreWeave / A-family
  "A100_family_bundled": "#b09dc2",
  // Meta MTIA
  "MTIA":                "#8e7cc3",
  // Fallback
  "_other":              "#999",
};

function chipColor(chip) {
  return CHIP_TYPE_COLORS[chip] || CHIP_TYPE_COLORS._other;
}

function render() {
  // Route to the chip-level preview when that view is active.
  if (state.view === "chip_level") {
    renderChipLevel();
    return;
  }

  // Show the sankey surface / hide chip-level surface.
  document.getElementById("sankey").style.display = "";
  document.getElementById("chip-level-grid").style.display = "none";
  document.getElementById("chip-level-banner").style.display = "none";
  document.getElementById("legend-sankey").style.display = "";
  document.getElementById("legend-chip").style.display = "none";

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

// ---------- Chip-level 2025 preview view ----------

function renderChipLevel() {
  // Show the grid surface / hide sankey.
  document.getElementById("sankey").style.display = "none";
  document.getElementById("chip-level-grid").style.display = "grid";
  document.getElementById("chip-level-banner").style.display = "block";
  document.getElementById("legend-sankey").style.display = "none";
  document.getElementById("legend-chip").style.display = "flex";

  // Pick the year's dataset.
  CHIP_LEVEL_DATA = CHIP_LEVEL_BY_YEAR[state.year] || null;

  const grid = document.getElementById("chip-level-grid");
  grid.innerHTML = "";

  if (!CHIP_LEVEL_DATA) {
    const d = document.createElement("div");
    d.style.color = "#c33";
    d.textContent = `chip_level_${state.year}.json not loaded — run sync/sheet_to_chip_level.py`;
    grid.appendChild(d);
    return;
  }

  const order = CHIP_LEVEL_DATA.owners_order || Object.keys(CHIP_LEVEL_DATA.owners);
  for (const owner of order) {
    const o = CHIP_LEVEL_DATA.owners[owner];
    if (!o) continue;
    grid.appendChild(buildOwnerCard(owner, o));
  }

  // Build a global chip legend (union of chip types seen across owners).
  const allChips = new Set();
  for (const o of Object.values(CHIP_LEVEL_DATA.owners)) {
    for (const c of o.cells) allChips.add(c.chip_type);
  }
  const legend = document.getElementById("legend-chip");
  legend.innerHTML = "";
  const chipsOrdered = [...allChips].sort((a, b) => a.localeCompare(b));
  for (const chip of chipsOrdered) {
    const el = document.createElement("div");
    el.className = "legend-item";
    el.innerHTML = `<span class="swatch" style="background:${chipColor(chip)}"></span> ${chip}`;
    legend.appendChild(el);
  }
}

function buildOwnerCard(owner, o) {
  const card = document.createElement("div");
  card.className = "chip-owner-card";

  const fleetTotal = o.fleet_total_h100e_median;
  card.innerHTML = `
    <h3>${owner} <span class="owner-meta">— ${formatNumber(fleetTotal)} H100e fleet, ${o.cells.length} cells</span></h3>
  `;

  const svg = d3.select(card).append("svg").node();
  // Defer render until the card has been laid out by the browser, so
  // svgNode.clientWidth reflects the real rendered width.
  requestAnimationFrame(() => renderOwnerStackedBar(svg, owner, o));
  return card;
}

function renderOwnerStackedBar(svgNode, owner, o) {
  const svg = d3.select(svgNode);
  // Clear first, then measure
  svg.selectAll("*").remove();

  const width = svgNode.clientWidth || svgNode.parentNode.clientWidth || 520;
  const height = 260;
  svg.attr("width", width).attr("height", height);

  const margin = { top: 10, right: 14, bottom: 58, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  // Aggregate cells by (user, chip_type) — already unique in source, but be safe.
  // Group by user for the x-axis, stacked by chip_type on y.
  const users = [];
  const userMap = new Map();
  for (const c of o.cells) {
    if (!userMap.has(c.user)) {
      userMap.set(c.user, { user: c.user, total: 0, byChip: new Map() });
      users.push(c.user);
    }
    const u = userMap.get(c.user);
    u.total += c.h100e_median;
    const prev = u.byChip.get(c.chip_type);
    if (prev) {
      prev.h100e_median += c.h100e_median;
      prev.h100e_ci_low += c.h100e_ci_low;
      prev.h100e_ci_high += c.h100e_ci_high;
      prev._cells.push(c);
    } else {
      u.byChip.set(c.chip_type, {
        chip_type: c.chip_type,
        h100e_median: c.h100e_median,
        h100e_ci_low: c.h100e_ci_low,
        h100e_ci_high: c.h100e_ci_high,
        _cells: [c],
      });
    }
  }

  // Sort users by total descending (largest first, makes the chart scan left-to-right).
  users.sort((a, b) => userMap.get(b).total - userMap.get(a).total);

  // Chip order for stack (bottom→top): fixed ordering so the same chip is at the
  // same height across users within the owner.
  const chipOrder = [];
  const seen = new Set();
  for (const u of users) {
    for (const chip of userMap.get(u).byChip.keys()) {
      if (!seen.has(chip)) { seen.add(chip); chipOrder.push(chip); }
    }
  }

  const yMax = d3.max(users, u => userMap.get(u).total) || 1;

  const x = d3.scaleBand()
    .domain(users)
    .range([0, innerW])
    .padding(0.2);
  const y = d3.scaleLinear()
    .domain([0, yMax * 1.08])
    .range([innerH, 0])
    .nice();

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Axes
  const xAxis = d3.axisBottom(x).tickSizeOuter(0);
  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(xAxis)
    .selectAll("text")
      .attr("transform", "rotate(-30)")
      .attr("text-anchor", "end")
      .attr("dx", "-0.5em")
      .attr("dy", "0.5em");

  const yAxis = d3.axisLeft(y).ticks(5).tickFormat(v => formatNumber(v));
  g.append("g")
    .attr("class", "axis")
    .call(yAxis);

  // Bars — per user, stacked by chip_type (bottom = first chip in chipOrder).
  for (const user of users) {
    const u = userMap.get(user);
    const stackG = g.append("g").attr("class", "bar-stack");
    let yTop = 0;
    const xBar = x(user);
    const wBar = x.bandwidth();

    for (const chip of chipOrder) {
      const seg = u.byChip.get(chip);
      if (!seg) continue;
      const h = innerH - y(yTop + seg.h100e_median) - (innerH - y(yTop));
      // (Simpler: (y(yTop) - y(yTop + seg.h100e_median)))
      const segTop = y(yTop + seg.h100e_median);
      const segBot = y(yTop);
      stackG.append("rect")
        .attr("x", xBar)
        .attr("y", segTop)
        .attr("width", wBar)
        .attr("height", Math.max(0.5, segBot - segTop))
        .attr("fill", chipColor(chip))
        .on("mousemove", (event) => showTooltip(event, chipCellTooltipHTML(owner, user, seg)))
        .on("mouseleave", hideTooltip);
      yTop += seg.h100e_median;
    }

    // Label total above the bar
    stackG.append("text")
      .attr("class", "bar-label")
      .attr("x", xBar + wBar / 2)
      .attr("y", y(u.total) - 4)
      .attr("text-anchor", "middle")
      .text(formatNumber(u.total));
  }

  // Y-axis title
  svg.append("text")
    .attr("transform", `translate(14,${margin.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#666")
    .text("H100e");
}

function chipCellTooltipHTML(owner, user, seg) {
  const cellLines = seg._cells.map(c => {
    const src = c.source_url
      ? `<a href="${c.source_url}" target="_blank" rel="noopener">source</a>`
      : (c.source_label || "");
    const conf = (c.confidence_pct != null) ? ` — ${c.confidence_pct}% conf` : "";
    return `<div class="sub">share=${(c.share_median*100).toFixed(1)}% [${(c.share_ci_low*100).toFixed(1)}–${(c.share_ci_high*100).toFixed(1)}%]${conf} · ${src}</div>`;
  }).join("");
  return `
    <div class="value">${owner} → ${user}</div>
    <div class="sub">${seg.chip_type}: ${formatNumber(seg.h100e_median)} H100e</div>
    <div class="sub">80% CI: ${formatNumber(seg.h100e_ci_low)}–${formatNumber(seg.h100e_ci_high)}</div>
    ${cellLines}
  `;
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

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function ciRangeHTML(low, high) {
  return `${formatNumber(low)}–${formatNumber(high)}`;
}

function metricNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function matchOwnerKey(entityName, cl) {
  if (!entityName || !cl || !cl.owners) return null;
  if (Object.prototype.hasOwnProperty.call(cl.owners, entityName)) return entityName;
  const target = String(entityName).toLowerCase();
  return Object.keys(cl.owners).find(owner => owner.toLowerCase() === target) || null;
}

function matchUserKey(entityName, cl) {
  if (!entityName || !cl || !cl.owners) return null;
  const target = String(entityName).toLowerCase();
  for (const owner of Object.values(cl.owners)) {
    for (const cell of (owner.cells || [])) {
      const user = cell.user || "";
      if (String(user).toLowerCase() === target) return user;
    }
  }
  return null;
}

function sumMetricRows(rows) {
  return rows.reduce((acc, row) => {
    acc.median += metricNumber(row.median);
    acc.low += metricNumber(row.low);
    acc.high += metricNumber(row.high);
    return acc;
  }, { median: 0, low: 0, high: 0 });
}

function isOtherUserBucket(user) {
  const label = String(user || "").trim().toLowerCase();
  return !label || label.startsWith("other");
}

function richHoverPanelHTML(d) {
  const cl = CHIP_LEVEL_BY_YEAR[state.year];
  if (!cl) return "";
  if (d.country !== "us") return "";
  if (d.stage === "own") return ownerHoverPanel(d, cl);
  if (d.stage === "use") return userHoverPanel(d, cl);
  return "";
}

function ownerHoverPanel(d, cl) {
  const ownerKey = matchOwnerKey(d.entity, cl);
  if (!ownerKey) return "";
  const owner = cl.owners[ownerKey];
  if (!owner) return "";

  const fleetRows = Object.entries(owner.fleet || {}).map(([chipType, metrics]) => ({
    chipType,
    median: metricNumber(metrics.h100e_median),
    low: metricNumber(metrics.h100e_ci_low),
    high: metricNumber(metrics.h100e_ci_high),
  })).sort((a, b) => b.median - a.median);
  const fleetTotal = sumMetricRows(fleetRows);

  const userTotals = new Map();
  for (const cell of (owner.cells || [])) {
    const user = cell.user || "";
    if (!userTotals.has(user)) userTotals.set(user, { user, median: 0, low: 0, high: 0 });
    const row = userTotals.get(user);
    row.median += metricNumber(cell.h100e_median);
    row.low += metricNumber(cell.h100e_ci_low);
    row.high += metricNumber(cell.h100e_ci_high);
  }
  const allUserRows = Array.from(userTotals.values()).sort((a, b) => b.median - a.median);
  const topRows = allUserRows.filter(row => !isOtherUserBucket(row.user)).slice(0, 5);
  const topUsers = new Set(topRows.map(row => row.user));
  const residualRows = allUserRows.filter(row => isOtherUserBucket(row.user) || !topUsers.has(row.user));
  const residualTotal = sumMetricRows(residualRows);

  const fleetTable = fleetRows.length ? `
    <table class="hover-table">
      <caption>Fleet by chip type (H100e, end of ${state.year})</caption>
      <thead>
        <tr><th>chip_type</th><th class="num">median</th><th class="num">80% CI</th></tr>
      </thead>
      <tbody>
        ${fleetRows.map(row => `
          <tr>
            <td>${escapeHTML(row.chipType)}</td>
            <td class="num">${formatNumber(row.median)}</td>
            <td class="num">${ciRangeHTML(row.low, row.high)}</td>
          </tr>
        `).join("")}
        <tr class="total">
          <td>Total</td>
          <td class="num">${formatNumber(fleetTotal.median)}</td>
          <td class="num">${ciRangeHTML(fleetTotal.low, fleetTotal.high)}</td>
        </tr>
      </tbody>
    </table>
  ` : "";

  const userRows = residualRows.length
    ? [...topRows, { user: "Other / residual", ...residualTotal }]
    : topRows;
  const usersTable = userRows.length ? `
    <table class="hover-table">
      <caption>Top users this year (H100e)</caption>
      <thead>
        <tr><th>user</th><th class="num">median H100e</th><th class="num">80% CI</th></tr>
      </thead>
      <tbody>
        ${userRows.map(row => `
          <tr>
            <td>${escapeHTML(row.user)}</td>
            <td class="num">${formatNumber(row.median)}</td>
            <td class="num">${ciRangeHTML(row.low, row.high)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : "";

  return fleetTable + usersTable;
}

function userHoverPanel(d, cl) {
  const userKey = matchUserKey(d.entity, cl) || d.entity || d.label || "";
  const target = String(userKey).toLowerCase();
  const rows = [];

  if (target) {
    for (const [ownerKey, owner] of Object.entries(cl.owners || {})) {
      for (const cell of (owner.cells || [])) {
        if (String(cell.user || "").toLowerCase() !== target) continue;
        rows.push({
          owner: ownerKey,
          chipType: cell.chip_type || "",
          median: metricNumber(cell.h100e_median),
          low: metricNumber(cell.h100e_ci_low),
          high: metricNumber(cell.h100e_ci_high),
        });
      }
    }
  }

  if (!rows.length) {
    const userLabel = userKey || d.entity || d.label || "this user";
    return `<div class="sub">No chip-level rows for ${escapeHTML(userLabel)} in ${state.year}.</div>`;
  }

  // Total sums over ALL rows (so the "All owners" line reflects every cell that
  // mentions this user, not just what we render). We hide rows with a median
  // that rounds to 0 under formatNumber (< 500 H100e) and a CI upper bound
  // that also rounds to 0, to keep the tooltip compact when many owners have
  // near-zero exposure.
  const total = sumMetricRows(rows);
  const MIN_MEDIAN = 500;
  const visibleRows = rows.filter(r => r.median >= MIN_MEDIAN || r.high >= MIN_MEDIAN);
  const hiddenCount = rows.length - visibleRows.length;
  if (!visibleRows.length) visibleRows.push(...rows.slice(0, Math.min(3, rows.length)));
  visibleRows.sort((a, b) => a.owner.localeCompare(b.owner) || b.median - a.median);
  const hiddenNote = hiddenCount > 0
    ? `<div class="sub hover-footer">${hiddenCount} near-zero row${hiddenCount === 1 ? "" : "s"} hidden.</div>`
    : "";
  return `
    <table class="hover-table">
      <caption>Compute from owners (H100e, end of ${state.year})</caption>
      <thead>
        <tr><th>owner</th><th>chip_type</th><th class="num">median</th><th class="num">80% CI</th></tr>
      </thead>
      <tbody>
        ${visibleRows.map(row => `
          <tr>
            <td>${escapeHTML(row.owner)}</td>
            <td>${escapeHTML(row.chipType)}</td>
            <td class="num">${formatNumber(row.median)}</td>
            <td class="num">${ciRangeHTML(row.low, row.high)}</td>
          </tr>
        `).join("")}
        <tr class="total">
          <td>All owners</td>
          <td></td>
          <td class="num">${formatNumber(total.median)}</td>
          <td class="num">${ciRangeHTML(total.low, total.high)}</td>
        </tr>
      </tbody>
    </table>
    ${hiddenNote}
  `;
}

function nodeTooltipHTML(d) {
  const headerHTML = `
    <div class="value">${escapeHTML(d.label)}</div>
    <div class="sub">${formatNumber(d.value)} H100e installed base through end of ${state.year}</div>
    ${d.is_dummy ? dummyBadge() : ""}
  `;
  const rich = richHoverPanelHTML(d);
  const footer = `<div class="sub hover-footer">Click to open sheet tab.</div>`;
  return headerHTML + rich + footer;
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

  // View toggle
  document.querySelectorAll("input[name='view-mode']").forEach(el => {
    el.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.view = e.target.value;
        updateShowAllVisibility();
        render();
      }
    });
  });

  // "Show all entities" — swaps the per-company view between bucketed
  // (small entities merged into *_other) and full (no threshold applied).
  const showAllEl = document.getElementById("show-all-entities");
  if (showAllEl) {
    showAllEl.addEventListener("change", (e) => {
      state.showAll = e.target.checked;
      render();
    });
  }
  updateShowAllVisibility();

  window.addEventListener("resize", render);
  updateYearButtons();
}

function updateShowAllVisibility() {
  // The checkbox only applies to the By-company view.
  const group = document.getElementById("show-all-group");
  if (group) group.style.display = state.view === "by_company" ? "" : "none";
  // Year selector applies to all views (chip-level is now per-year).
  const yearWrap = document.getElementById("year-selector");
  const yearGroup = yearWrap ? yearWrap.closest(".control-group") : null;
  if (yearGroup) yearGroup.style.display = "";
}

function updateYearButtons() {
  const btns = document.querySelectorAll("#year-selector button");
  btns.forEach(b => {
    const y = Number(b.dataset.year);
    b.classList.toggle("active", y === state.year);
  });
  // Update subtitle year label
  const yearLabel = document.getElementById("year-label");
  if (yearLabel) yearLabel.textContent = state.year;
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

// Years for which chip-level JSONs are expected to exist. Must match
// YEARS in sync/sheet_to_chip_level.py.
const CHIP_LEVEL_YEARS = [2022, 2023, 2024, 2025];

function fetchChipLevelYear(year) {
  return fetch(`chip_level_${year}.json`, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
}

Promise.all([
  fetch("data.json", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error(`data.json HTTP ${r.status}`);
    return r.json();
  }),
  Promise.all(CHIP_LEVEL_YEARS.map(fetchChipLevelYear)),
])
  .then(([pipeline, chipLevelYears]) => {
    PIPELINE_DATA = pipeline;
    CHIP_LEVEL_BY_YEAR = {};
    CHIP_LEVEL_YEARS.forEach((y, i) => {
      if (chipLevelYears[i]) CHIP_LEVEL_BY_YEAR[y] = chipLevelYears[i];
    });
    CHIP_LEVEL_DATA = CHIP_LEVEL_BY_YEAR[state.year] || null;
    if (Array.isArray(pipeline.years) && pipeline.years.length) {
      state.year = pipeline.years.includes(2025) ? 2025 : pipeline.years[pipeline.years.length - 1];
    }
    setupControls();
    render();
  })
  .catch(err => {
    console.error("Failed to load data.json:", err);
    showLoadError("Failed to load data.json — run sync/sheet_to_json.py.");
  });
