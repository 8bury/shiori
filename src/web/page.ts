// Static HTML for the web viewer. All dynamic text is inserted with textContent;
// note Markdown is rendered with marked and sanitized with DOMPurify.

const STYLE = `
:root{--bg:#f7f4ee;--panel:#fffdf8;--ink:#1f2328;--muted:#6b6f76;--line:#e4ddd0;--accent:#b4442f;--chip:#efe8db;--code:#f1ece2;--ok:#3d7fb8;--err:#c43d2f;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--panel:#1b2026;--ink:#e6e3dc;--muted:#9097a0;--line:#2b323a;--accent:#e2775f;--chip:#252c34;--code:#222930;--ok:#5b9bd5;--err:#e8665a;--warn:#e0a84a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
header{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:700;letter-spacing:.02em;white-space:nowrap}
.brand span{color:var(--accent)}
nav{display:flex;gap:4px}
nav button,.btn{background:none;border:1px solid transparent;color:var(--muted);padding:6px 10px;border-radius:8px;cursor:pointer;font:inherit}
nav button.on{background:var(--chip);color:var(--ink)}
.btn{border-color:var(--line)}
#q{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
main{max-width:1100px;margin:0 auto;padding:16px}
.stats{color:var(--muted);font-size:13px;margin-bottom:12px}
.mem{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
.seq{color:var(--muted);font:12px ui-monospace,monospace;padding-top:3px}
.meta{color:var(--muted);font-size:12px}
.day{margin:18px 0 4px;font-weight:600;color:var(--accent);font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.notes{display:grid;grid-template-columns:280px 1fr;gap:16px}
.list{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:calc(100vh - 120px);overflow:auto;position:sticky;top:70px}
.list .dir{color:var(--muted);font-size:12px;margin:8px 6px 2px}
.list a{display:block;padding:4px 8px;border-radius:6px;text-decoration:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list a.on,.list a:hover{background:var(--chip)}
article{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 24px;min-width:0;overflow-wrap:anywhere}
article pre{background:var(--code);padding:10px;border-radius:8px;overflow:auto}
article code{background:var(--code);padding:1px 4px;border-radius:4px}
article pre code{padding:0}
article table{border-collapse:collapse}article td,article th{border:1px solid var(--line);padding:4px 8px}
.path{font:12px ui-monospace,monospace;color:var(--muted);margin-bottom:8px}
.sum{padding:8px 0;border-bottom:1px solid var(--line)}
.range{display:inline-block;font:12px ui-monospace,monospace;background:var(--chip);border-radius:6px;padding:1px 6px;margin-right:8px}
h2{font-size:15px;margin:20px 0 6px}
.hit{padding:8px 0;border-bottom:1px solid var(--line)}
.hit .snip{color:var(--muted);white-space:pre-wrap;font-size:14px}
.empty{color:var(--muted);padding:24px 0}
.more{margin:16px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.tile .l{color:var(--muted);font-size:12px}
.tile.bad .v{color:var(--err)}.tile.warn .v{color:var(--warn)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0;overflow-x:auto}
.card h3{margin:0 0 8px;font-size:14px}
table.t{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
table.t th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;border-bottom:1px solid var(--line);padding:4px 8px}
table.t td{border-bottom:1px solid var(--line);padding:5px 8px}
table.t td.n,table.t th.n{text-align:right}
.e{color:var(--err)}.w{color:var(--warn)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-bottom:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;border-radius:0}
.seg button.on{background:var(--chip);color:var(--ink)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
svg text{fill:var(--muted);font-size:10px}
@media (max-width:760px){header{flex-wrap:wrap}#q{order:3;flex-basis:100%}.notes{grid-template-columns:1fr}.list{position:static;max-height:40vh}article{padding:16px}}
`;

export const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shiori</title><style>${STYLE}
.login{max-width:360px;margin:18vh auto;text-align:center;padding:0 16px}
.login h1{font-size:42px;margin:0}.login p{color:var(--muted)}
.gh{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600}
</style></head><body><div class="login"><h1>栞</h1><p>Shiori: your shared memory and notes.</p>
<a class="gh" href="/ui/login">Sign in with GitHub</a></div></body></html>`;

export const UI_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shiori</title><style>${STYLE}</style>
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
</head><body>
<header>
  <div class="brand"><span>栞</span> Shiori</div>
  <nav><button data-tab="timeline" class="on">Memories</button><button data-tab="notes">Notes</button><button data-tab="tree">Summaries</button><button data-tab="health">Health</button></nav>
  <input id="q" type="search" placeholder="Search memories and notes..." autocomplete="off">
  <form method="post" action="/ui/logout"><button class="btn">Sign out</button></form>
</header>
<main id="main"></main>
<script>
const $main = document.getElementById("main");
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
async function api(path) {
  const r = await fetch("/ui/api/" + path, { credentials: "same-origin" });
  if (r.status === 401) { location.reload(); throw new Error("unauthorized"); }
  return r.json();
}
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" }); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
const md = (src) => DOMPurify.sanitize(marked.parse(src));

let tab = "timeline";
document.querySelectorAll("nav button").forEach((b) => b.onclick = () => go(b.dataset.tab));
function setTab(t) { tab = t; document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); }

async function timeline() {
  const s = await api("stats");
  $main.replaceChildren(el("div", { className: "stats", textContent: s.memories + " memories · " + s.summaries + " summaries · " + s.notes + " notes" }));
  const box = el("div"); $main.append(box);
  let lastDay = "", before = null;
  async function page() {
    const { memories } = await api("memories?limit=150" + (before !== null ? "&before=" + before : ""));
    for (const m of memories) {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) { box.append(el("div", { className: "day", textContent: day })); lastDay = day; }
      box.append(el("div", { className: "mem" },
        el("div", { className: "seq", textContent: "#" + m.seq }),
        el("div", {}, el("div", { textContent: m.content }), el("div", { className: "meta", textContent: fmtTime(m.created_at) + (m.source ? " · " + m.source : "") }))));
      before = m.seq;
    }
    more.remove();
    if (memories.length === 150) box.after(more);
    if (!box.children.length) box.append(el("div", { className: "empty", textContent: "No memories yet." }));
  }
  const more = el("button", { className: "btn more", textContent: "Load older", onclick: page });
  await page();
}

async function notes(open) {
  const { notes } = await api("notes");
  const list = el("div", { className: "list" }), art = el("article");
  let lastDir = null;
  for (const p of notes) {
    const i = p.lastIndexOf("/"), dir = i < 0 ? "" : p.slice(0, i);
    if (dir !== lastDir) { if (dir) list.append(el("div", { className: "dir", textContent: dir + "/" })); lastDir = dir; }
    const a = el("a", { href: "#note=" + encodeURIComponent(p), textContent: p.slice(i + 1), title: p });
    a.dataset.path = p; list.append(a);
  }
  if (!notes.length) list.append(el("div", { className: "empty", textContent: "No notes yet." }));
  $main.replaceChildren(el("div", { className: "notes" }, list, art));
  const target = open || notes[0];
  if (target) await showNote(target, list, art);
  else art.append(el("div", { className: "empty", textContent: "Nothing to show." }));
}
async function showNote(p, list, art) {
  list.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.path === p));
  const r = await api("note?path=" + encodeURIComponent(p));
  const body = el("div"); body.innerHTML = r.content ? md(r.content) : "";
  art.replaceChildren(el("div", { className: "path", textContent: p }), r.error ? el("div", { className: "empty", textContent: r.error }) : body);
}

async function tree() {
  const { summaries } = await api("summaries");
  $main.replaceChildren(el("div", { className: "stats", textContent: summaries.length + " summary nodes (largest ranges first)" }));
  for (const s of summaries) $main.append(el("div", { className: "sum" }, el("span", { className: "range", textContent: "#" + s.lo + "-" + s.hi }), document.createTextNode(s.summary)));
  if (!summaries.length) $main.append(el("div", { className: "empty", textContent: "No summaries yet." }));
}

async function search(q) {
  const r = await api("search?q=" + encodeURIComponent(q));
  $main.replaceChildren(el("h2", { textContent: "Memories" }));
  if (r.memoryError) $main.append(el("div", { className: "empty", textContent: r.memoryError }));
  for (const line of r.memories) $main.append(el("div", { className: "hit", textContent: line }));
  if (!r.memories.length && !r.memoryError) $main.append(el("div", { className: "empty", textContent: "No memories found." }));
  $main.append(el("h2", { textContent: "Notes" }));
  if (r.notesError) $main.append(el("div", { className: "empty", textContent: r.notesError }));
  for (const n of r.notes) $main.append(el("div", { className: "hit" },
    el("a", { href: "#note=" + encodeURIComponent(n.path), textContent: n.path }),
    el("span", { className: "meta", textContent: "  " + n.matched }),
    el("div", { className: "snip", textContent: n.text.slice(0, 300) })));
  if (!r.notes.length && !r.notesError) $main.append(el("div", { className: "empty", textContent: "No notes found." }));
}

const nf = (n) => Number(n || 0).toLocaleString();
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "0%");
const ago = (iso) => { if (!iso) return "never"; const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
function tile(label, value, cls = "") { return el("div", { className: "tile " + cls }, el("div", { className: "v", textContent: value }), el("div", { className: "l", textContent: label })); }
function table(cols, rows) {
  const t = el("table", { className: "t" });
  t.append(el("tr", {}, ...cols.map((c) => el("th", { className: c.n ? "n" : "", textContent: c.h }))));
  for (const r of rows) t.append(el("tr", {}, ...cols.map((c) => { const v = c.v(r); const td = el("td", { className: (c.n ? "n " : "") + (c.cls ? c.cls(r) : "") }); td.append(v instanceof Node ? v : document.createTextNode(v)); return td; })));
  if (!rows.length) t.append(el("tr", {}, el("td", { className: "meta", colSpan: cols.length, textContent: "No data in this period." })));
  return t;
}
function chart(series, hours) {
  // Buckets: hourly up to 48h, daily beyond
  const daily = hours > 48, step = daily ? 86400000 : 3600000;
  const end = Math.floor(Date.now() / step) * step, n = daily ? Math.ceil(hours / 24) : hours;
  const b = Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * step, ok: 0, err: 0 }));
  for (const r of series) { if (r.kind !== "tool") continue; const t = Math.floor(new Date(r.hour) / step) * step; const x = b.find((y) => y.t === t); if (x) { x.ok += r.ok; x.err += r.err; } }
  const W = 1000, H = 160, pad = 18, max = Math.max(1, ...b.map((x) => x.ok + x.err)), bw = W / n;
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + (H + pad)); svg.setAttribute("width", "100%"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "MCP tool calls over time");
  const add = (tag, a) => { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  b.forEach((x, i) => {
    const hOk = (x.ok / max) * H, hErr = (x.err / max) * H, gx = i * bw + bw * 0.12, w = Math.max(1, bw * 0.76);
    const g = add("g", {}); const title = document.createElementNS(ns, "title");
    title.textContent = new Date(x.t).toLocaleString(undefined, daily ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "2-digit" }) + ": " + x.ok + " ok, " + x.err + " errors"; g.append(title);
    const r1 = document.createElementNS(ns, "rect"); Object.entries({ x: gx, y: H - hOk, width: w, height: hOk, fill: "var(--ok)", rx: 1.5 }).forEach(([k, v]) => r1.setAttribute(k, v)); g.append(r1);
    const r2 = document.createElementNS(ns, "rect"); Object.entries({ x: gx, y: H - hOk - hErr, width: w, height: hErr, fill: "var(--err)", rx: 1.5 }).forEach(([k, v]) => r2.setAttribute(k, v)); g.append(r2);
    const r3 = document.createElementNS(ns, "rect"); Object.entries({ x: i * bw, y: 0, width: bw, height: H, fill: "transparent" }).forEach(([k, v]) => r3.setAttribute(k, v)); g.append(r3);
  });
  add("line", { x1: 0, x2: W, y1: H, y2: H, stroke: "var(--line)" });
  const labels = daily ? Math.min(n, 8) : 6;
  for (let k = 0; k < labels; k++) { const i = Math.round((k * (n - 1)) / Math.max(1, labels - 1)); const tx = add("text", { x: i * bw + bw / 2, y: H + 13, "text-anchor": "middle" }); tx.textContent = new Date(b[i].t).toLocaleString(undefined, daily ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }); }
  const mx = add("text", { x: 2, y: 10 }); mx.textContent = "max " + max;
  return svg;
}
async function health(hours) {
  const d = await api("health?hours=" + hours);
  const tools = d.totals.filter((r) => r.kind === "tool"), clients = d.totals.filter((r) => r.kind === "client");
  const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const calls = sum(tools, "ok") + sum(tools, "err"), errs = sum(tools, "err"), rl = sum(d.totals.filter((r) => r.kind !== "client"), "rate_limited");
  const svcErr = sum(d.totals.filter((r) => r.kind === "service"), "err");
  const unauth = sum(d.totals.filter((r) => r.kind === "http" && r.name === "mcp_unauthorized"), "ok");
  const avg = calls ? Math.round(sum(tools, "total_ms") / calls) + " ms" : "-";
  const seg = el("div", { className: "seg" }, ...[[24, "24h"], [168, "7d"], [720, "30d"]].map(([h, l]) => el("button", { className: "btn" + (h === hours ? " on" : ""), textContent: l, onclick: () => (location.hash = "health=" + h) })));
  const head = el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap" }, el("div", { className: "stats", style: "margin:0", textContent: "Since " + new Date(d.since).toLocaleString() }), seg);
  $main.replaceChildren(head, el("div", { className: "tiles" },
    tile("MCP tool calls", nf(calls)),
    tile("Tool errors (" + pct(errs, calls) + ")", nf(errs), errs ? "bad" : ""),
    tile("Rate-limited (429 / quota)", nf(rl), rl ? "warn" : ""),
    tile("Background API errors", nf(svcErr), svcErr ? "bad" : ""),
    tile("Avg tool latency", avg),
    tile("Open alerts", nf(d.openAlerts.length), d.openAlerts.length ? "bad" : ""),
    tile("Unauthorized /mcp hits", nf(unauth))));
  $main.append(el("div", { className: "card" }, el("h3", { textContent: "Tool calls over time" }),
    el("div", { className: "legend" }, el("span", {}, el("i", { style: "background:var(--ok)" }), "ok"), el("span", {}, el("i", { style: "background:var(--err)" }), "error")), chart(d.series, hours)));
  const lat = (r) => { const c = Number(r.ok) + Number(r.err); return c ? Math.round(r.total_ms / c) + " ms" : "-"; };
  const cols = (label) => [
    { h: label, v: (r) => r.name }, { h: "Calls", n: 1, v: (r) => nf(Number(r.ok) + Number(r.err)) },
    { h: "Errors", n: 1, v: (r) => nf(r.err), cls: (r) => (r.err ? "e" : "") }, { h: "Error rate", n: 1, v: (r) => pct(r.err, Number(r.ok) + Number(r.err)) },
    { h: "Rate-limited", n: 1, v: (r) => nf(r.rate_limited), cls: (r) => (r.rate_limited ? "w" : "") }, { h: "Avg latency", n: 1, v: lat }];
  $main.append(el("div", { className: "card" }, el("h3", { textContent: "By tool" }), table(cols("Tool"), tools)));
  $main.append(el("div", { className: "card" }, el("h3", { textContent: "By client" }), table(cols("Client"), clients)));
  const svcTotals = (name) => d.totals.find((r) => r.kind === "service" && r.name === name) || { ok: 0, err: 0, rate_limited: 0, total_ms: 0 };
  const svcRows = [["Embeddings", "embedding", d.services.embedding], ["Memory summaries", "memory-summary", d.services.memorySummary]].map(([label, key, s]) => ({ label, s, t: svcTotals(key) }));
  const status = (s) => { const state = s.disabled || s.provider === "none" ? ["disabled", "var(--muted)"] : s.consecutiveFailures ? [s.lastRateLimited ? "rate-limited" : "failing", s.lastRateLimited ? "var(--warn)" : "var(--err)"] : ["healthy", "var(--ok)"]; return el("span", {}, el("span", { className: "dot", style: "background:" + state[1] }), state[0]); };
  $main.append(el("div", { className: "card" }, el("h3", { textContent: "Background APIs" }), table([
    { h: "Service", v: (r) => r.label }, { h: "Provider", v: (r) => (r.s.provider || "-") + (r.s.model ? " / " + r.s.model : "") }, { h: "Status", v: (r) => status(r.s) },
    { h: "Calls", n: 1, v: (r) => nf(Number(r.t.ok) + Number(r.t.err)) }, { h: "Errors", n: 1, v: (r) => nf(r.t.err), cls: (r) => (r.t.err ? "e" : "") },
    { h: "Rate-limited", n: 1, v: (r) => nf(r.t.rate_limited), cls: (r) => (r.t.rate_limited ? "w" : "") }, { h: "Avg latency", n: 1, v: (r) => lat(r.t) },
    { h: "Last success", v: (r) => ago(r.s.lastSuccessAt) }], svcRows),
    d.services.memorySummary.pendingCompactions ? el("div", { className: "meta", style: "margin-top:6px", textContent: d.services.memorySummary.pendingCompactions + " memory compactions pending" }) : ""));
  if (d.openAlerts.length) $main.append(el("div", { className: "card" }, el("h3", { textContent: "Open alerts" }), table([
    { h: "When", v: (r) => ago(r.created_at) }, { h: "Source", v: (r) => r.source }, { h: "Detail", v: (r) => { try { const j = JSON.parse(r.body); return (j.rateLimited ? "[rate limit] " : "") + (j.error || r.body); } catch { return r.body; } } }], d.openAlerts)));
  $main.append(el("div", { className: "card" }, el("h3", { textContent: "Recent errors" }), table([
    { h: "When", v: (r) => ago(r.at) }, { h: "Where", v: (r) => r.kind + ": " + r.name },
    { h: "Type", v: (r) => (r.rate_limited ? "rate limit" : "error"), cls: (r) => (r.rate_limited ? "w" : "e") }, { h: "Message", v: (r) => r.message }], d.errors)));
}

function go(t) { location.hash = t; }
async function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  try {
    if (h.startsWith("note=")) { setTab("notes"); await notes(h.slice(5)); }
    else if (h.startsWith("q=")) { setTab(""); await search(h.slice(2)); }
    else if (h === "notes") { setTab("notes"); await notes(); }
    else if (h.startsWith("health")) { setTab("health"); await health(Number(h.split("=")[1]) || 24); }
    else if (h === "tree") { setTab("tree"); await tree(); }
    else { setTab("timeline"); await timeline(); }
  } catch (e) { if (e.message !== "unauthorized") $main.replaceChildren(el("div", { className: "empty", textContent: "Error: " + e.message })); }
}
let t;
document.getElementById("q").addEventListener("input", (e) => { clearTimeout(t); const v = e.target.value.trim(); t = setTimeout(() => { location.hash = v ? "q=" + encodeURIComponent(v) : "timeline"; }, 300); });
addEventListener("hashchange", route);
route();
</script></body></html>`;
