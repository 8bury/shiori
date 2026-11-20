// Static HTML for the web viewer. All dynamic text is inserted with textContent;
// note Markdown is rendered with marked and sanitized with DOMPurify.

const STYLE = `
:root{--bg:#f7f4ee;--panel:#fffdf8;--ink:#1f2328;--muted:#6b6f76;--line:#e4ddd0;--accent:#b4442f;--chip:#efe8db;--code:#f1ece2;--ok:#3d7fb8;--err:#c43d2f;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--panel:#1b2026;--ink:#e6e3dc;--muted:#9097a0;--line:#2b323a;--accent:#e2775f;--chip:#252c34;--code:#222930;--ok:#5b9bd5;--err:#e8665a;--warn:#e0a84a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
header{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:700;letter-spacing:.02em;white-space:nowrap}
.brand span{color:var(--accent)}
nav{display:flex;gap:4px}
nav button,.btn{background:none;border:1px solid transparent;color:var(--muted);padding:6px 10px;border-radius:8px;cursor:pointer;font:inherit}
nav button.on,.btn.on{background:var(--chip);color:var(--ink)}
.btn{border-color:var(--line)}
.btn.sm{padding:3px 8px;font-size:12px}
.btn:disabled{opacity:.6;cursor:default}
#q{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
main{max-width:1100px;margin:0 auto;padding:16px}
.stats{color:var(--muted);font-size:13px;margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mem{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
.mem.hi{background:var(--chip);border-radius:6px;padding:8px 6px;margin:0 -6px}
.seq{color:var(--muted);font:12px ui-monospace,monospace;padding-top:3px;text-decoration:none}
a.seq:hover{color:var(--accent);text-decoration:underline}
.meta{color:var(--muted);font-size:12px}
.day{margin:18px 0 4px;font-weight:600;color:var(--accent);font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.notes{display:grid;grid-template-columns:280px 1fr;gap:16px}
.list{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:calc(100vh - 120px);overflow:auto;position:sticky;top:70px}
.list-toggle{display:none;width:100%;text-align:left}
.note-filter{width:100%;padding:6px 8px;margin-bottom:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px}
.list .dir{color:var(--muted);font-size:12px;margin:8px 6px 2px}
.list a{display:block;padding:4px 8px;border-radius:6px;text-decoration:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list a.on,.list a:hover{background:var(--chip)}
article{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 24px;min-width:0;overflow-wrap:anywhere}
article pre{background:var(--code);padding:10px;border-radius:8px;overflow:auto}
article code{background:var(--code);padding:1px 4px;border-radius:4px}
article pre code{padding:0}
article table{border-collapse:collapse}article td,article th{border:1px solid var(--line);padding:4px 8px}
.note-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.path{font:12px ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}
.sum{padding:8px 0;border-bottom:1px solid var(--line)}
.range-btn{border:0;cursor:pointer;color:var(--ink);font:12px ui-monospace,monospace;background:var(--chip);border-radius:6px;padding:2px 7px;margin-right:8px}
.range-btn:hover{filter:brightness(.95)}
.sum-kids{margin:8px 0 4px 12px;padding-left:12px;border-left:2px solid var(--line)}
.sum-kids .mem{padding:5px 0}
h2{font-size:15px;margin:20px 0 6px}
.hit{padding:8px 0;border-bottom:1px solid var(--line)}
.hit-mem{display:flex;gap:10px;align-items:baseline}
.hit-mem .seq{flex:0 0 auto;padding-top:0}
.hit .snip{color:var(--muted);white-space:pre-wrap;font-size:14px}
mark{background:var(--chip);color:var(--ink);padding:0 2px;border-radius:3px}
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
.h-ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
svg text{fill:var(--muted);font-size:10px}
@media (max-width:760px){header{flex-wrap:wrap}#q{order:3;flex-basis:100%}.notes{grid-template-columns:1fr}.list-toggle{display:block}.list{position:static;max-height:45vh}.list.collapsed{display:none}article{padding:16px}}
`;

export const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shiori</title><style>${STYLE}
.login{max-width:360px;margin:18vh auto;text-align:center;padding:0 16px}
.login h1{font-size:42px;margin:0}.login p{color:var(--muted)}
.gh{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600}
</style></head><body><main class="login"><h1>栞</h1><p>Shiori: your shared memory and notes.</p>
<a class="gh" href="/ui/login">Sign in with GitHub</a></main></body></html>`;

export const UI_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shiori</title><style>${STYLE}</style>
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
</head><body>
<header>
  <div class="brand"><span>栞</span> Shiori</div>
  <nav aria-label="Primary"><button type="button" data-tab="timeline" class="on" aria-current="page">Memories</button><button type="button" data-tab="notes">Notes</button><button type="button" data-tab="tree">Summaries</button><button type="button" data-tab="health">Health</button></nav>
  <input id="q" type="search" placeholder="Search memories and notes..." aria-label="Search memories and notes" autocomplete="off">
  <form method="post" action="/ui/logout"><button type="submit" class="btn">Sign out</button></form>
</header>
<main id="main"></main>
<script>
const $main = document.getElementById("main");
const $q = document.getElementById("q");
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
async function api(path) {
  const r = await fetch("/ui/api/" + path, { credentials: "same-origin" });
  if (r.status === 401) { location.reload(); throw new Error("unauthorized"); }
  let data;
  try { data = await r.json(); } catch { throw new Error("Request failed (" + r.status + ")"); }
  if (!r.ok && (!data || typeof data.error !== "string")) throw new Error("Request failed (" + r.status + ")");
  return data;
}
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" }); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
const md = (src) => DOMPurify.sanitize(marked.parse(src));
const nf = (n) => Number(n || 0).toLocaleString();
const mobileMq = matchMedia("(max-width:760px)");

let tab = "timeline";
let lastTab = "timeline";
let navToken = 0;
let healthTimer = null;
let lastHealthHours = 24;
let healthAuto = false;
let notesShell = null;
let lastNote = "";
try { lastNote = sessionStorage.getItem("shiori.lastNote") || ""; } catch {}

function clearHealthTimer() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }
function setLoading(label) {
  $main.setAttribute("aria-busy", "true");
  $main.replaceChildren(el("div", { className: "empty", role: "status", textContent: label || "Loading..." }));
}
function doneLoading() { $main.removeAttribute("aria-busy"); }

document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
  const t = b.dataset.tab;
  if (t === "health") go("health=" + lastHealthHours);
  else go(t);
});
function setTab(t) {
  tab = t;
  if (t) lastTab = t;
  document.querySelectorAll("nav button").forEach((b) => {
    const active = b.dataset.tab === t;
    b.classList.toggle("on", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

function memRow(m, highlight) {
  const row = el("div", { className: highlight ? "mem hi" : "mem", id: "mem-" + m.seq },
    el("div", { className: "seq", textContent: "#" + m.seq }),
    el("div", {},
      el("div", { textContent: m.content }),
      el("div", { className: "meta", textContent: fmtTime(m.created_at) + (m.source ? " · " + m.source : "") })));
  return row;
}

async function timeline(targetSeq, token) {
  setLoading("Loading memories...");
  let totalText = "";
  let before = targetSeq !== null ? targetSeq + 25 : null;
  const limit = targetSeq !== null ? 60 : 150;
  if (targetSeq === null) {
    const s = await api("stats");
    if (token !== navToken) return;
    totalText = nf(s.memories) + (s.memories === 1 ? " memory" : " memories");
  }
  const box = el("div");
  let lastDay = "";
  let targetEl = null;
  const more = el("button", { type: "button", className: "btn more", textContent: "Load older" });

  async function page(isFirst) {
    if (!isFirst) { more.disabled = true; more.textContent = "Loading..."; }
    try {
      const { memories } = await api("memories?limit=" + limit + (before !== null ? "&before=" + before : ""));
      if (token !== navToken) return;
      if (isFirst) {
        const bar = targetSeq !== null
          ? el("div", { className: "stats" },
              el("span", { textContent: "Memories around #" + targetSeq }),
              el("button", { type: "button", className: "btn sm", textContent: "Show latest", onclick: () => go("timeline") }))
          : el("div", { className: "stats", textContent: totalText });
        $main.replaceChildren(bar, box);
        doneLoading();
      }
      for (const m of memories) {
        const day = fmtDay(m.created_at);
        if (day !== lastDay) { box.append(el("div", { className: "day", textContent: day })); lastDay = day; }
        const isTarget = targetSeq !== null && m.seq === targetSeq;
        const row = memRow(m, isTarget);
        if (isTarget) targetEl = row;
        box.append(row);
        before = m.seq;
      }
      more.remove();
      more.disabled = false;
      more.textContent = "Load older";
      if (memories.length === limit) box.after(more);
      if (!box.children.length) box.append(el("div", { className: "empty", textContent: targetSeq !== null ? "Memory #" + targetSeq + " was not found." : "No memories yet." }));
      if (isFirst && targetEl) targetEl.scrollIntoView({ block: "center" });
    } catch (e) {
      if (token !== navToken) return;
      more.disabled = false;
      more.textContent = "Load older";
      if (isFirst) throw e;
    }
  }
  more.onclick = () => page(false);
  await page(true);
}

async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch {}
  if (!ok) {
    const ta = el("textarea", { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
  }
  const prev = btn.textContent;
  btn.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => { btn.textContent = prev; }, 1500);
}

async function notes(open, token) {
  const mounted = notesShell && notesShell.root.isConnected;
  if (!mounted) {
    setLoading("Loading notes...");
    const { notes: paths } = await api("notes");
    if (token !== navToken) return;
    const list = el("div", { className: "list" });
    const art = el("article");
    const toggle = el("button", { type: "button", className: "btn list-toggle" });
    const filter = el("input", { id: "note-filter", className: "note-filter", type: "search", placeholder: "Filter notes", autocomplete: "off" });
    filter.setAttribute("aria-label", "Filter notes");
    const items = [];
    const dirs = [];
    const emptyFilter = el("div", { className: "empty", textContent: "No matching notes.", hidden: true });

    if (paths.length) {
      list.append(filter);
      let lastDir = null;
      let curDirEl = null;
      for (const p of paths) {
        const i = p.lastIndexOf("/");
        const dir = i < 0 ? "" : p.slice(0, i);
        if (dir !== lastDir) {
          curDirEl = dir ? el("div", { className: "dir", textContent: dir + "/" }) : null;
          if (curDirEl) { list.append(curDirEl); dirs.push({ el: curDirEl, links: [] }); }
          lastDir = dir;
        }
        const a = el("a", { href: "#note=" + encodeURIComponent(p), textContent: p.slice(i + 1), title: p });
        a.dataset.path = p;
        list.append(a);
        items.push(a);
        if (curDirEl) dirs[dirs.length - 1].links.push(a);
      }
      list.append(emptyFilter);
    } else {
      list.append(el("div", { className: "empty", textContent: "No notes yet." }));
    }

    function applyFilter() {
      const term = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const a of items) {
        const match = !term || a.dataset.path.toLowerCase().includes(term);
        a.hidden = !match;
        if (match) shown += 1;
      }
      for (const d of dirs) d.el.hidden = !d.links.some((a) => !a.hidden);
      emptyFilter.hidden = !(paths.length && shown === 0);
    }
    filter.addEventListener("input", applyFilter);

    function setSidebarOpen(isOpen) {
      list.classList.toggle("collapsed", !isOpen);
      toggle.setAttribute("aria-expanded", String(isOpen));
      toggle.textContent = (isOpen ? "Hide notes (" : "Show notes (") + paths.length + ")";
    }
    toggle.onclick = () => setSidebarOpen(list.classList.contains("collapsed"));
    setSidebarOpen(!(open && mobileMq.matches));

    const root = el("div", { className: "notes" }, toggle, list, art);
    $main.replaceChildren(root);
    doneLoading();
    notesShell = { root, list, art, filter, items, paths, setSidebarOpen };
  }

  const target = open || (lastNote && notesShell.paths.includes(lastNote) ? lastNote : notesShell.paths[0]);
  if (target) await showNote(target, token);
  else notesShell.art.replaceChildren(el("div", { className: "empty", textContent: "Select a note to read." }));
}

async function showNote(p, token) {
  const { list, art, items, setSidebarOpen } = notesShell;
  lastNote = p;
  try { sessionStorage.setItem("shiori.lastNote", p); } catch {}
  for (const a of items) {
    const on = a.dataset.path === p;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (mobileMq.matches) setSidebarOpen(false);
  art.setAttribute("aria-busy", "true");
  art.replaceChildren(
    el("div", { className: "note-head" }, el("div", { className: "path", textContent: p })),
    el("div", { className: "empty", role: "status", textContent: "Loading note..." }));
  const r = await api("note?path=" + encodeURIComponent(p));
  if (token !== navToken) return;
  art.removeAttribute("aria-busy");
  const copyBtn = el("button", { type: "button", className: "btn sm", textContent: "Copy path" });
  copyBtn.setAttribute("aria-label", "Copy note path");
  copyBtn.onclick = () => copyText(p, copyBtn);
  const head = el("div", { className: "note-head" }, el("div", { className: "path", textContent: p }), copyBtn);
  if (r.error) {
    art.replaceChildren(head, el("div", { className: "empty", textContent: r.error }));
    return;
  }
  if (!r.content) {
    art.replaceChildren(head, el("div", { className: "empty", textContent: "This note is empty." }));
    return;
  }
  const body = el("div");
  body.innerHTML = md(r.content);
  art.replaceChildren(head, body);
  if (mobileMq.matches) art.scrollIntoView({ block: "nearest" });
}

async function tree(token) {
  setLoading("Loading summaries...");
  const { summaries } = await api("summaries");
  if (token !== navToken) return;
  $main.replaceChildren(el("div", { className: "stats", textContent: nf(summaries.length) + (summaries.length === 1 ? " summary node" : " summary nodes") }));
  for (const s of summaries) {
    const btn = el("button", { type: "button", className: "range-btn", textContent: "#" + s.lo + "-" + s.hi });
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Toggle memories #" + s.lo + " to #" + s.hi);
    const row = el("div", { className: "sum" }, btn, document.createTextNode(s.summary));
    let kids = null;
    btn.onclick = async () => {
      if (kids) {
        kids.hidden = !kids.hidden;
        btn.setAttribute("aria-expanded", String(!kids.hidden));
        return;
      }
      kids = el("div", { className: "sum-kids" }, el("div", { className: "meta", role: "status", textContent: "Loading..." }));
      row.append(kids);
      btn.setAttribute("aria-expanded", "true");
      try {
        const { memories } = await api("memories?lo=" + s.lo + "&hi=" + s.hi + "&limit=200");
        const nodes = memories.map((m) => el("div", { className: "mem" },
          el("a", { className: "seq", href: "#seq=" + m.seq, textContent: "#" + m.seq, title: "View in timeline" }),
          el("div", {},
            el("div", { textContent: m.content }),
            el("div", { className: "meta", textContent: fmtTime(m.created_at) + (m.source ? " · " + m.source : "") }))));
        if (!nodes.length) nodes.push(el("div", { className: "meta", textContent: "No memories in this range." }));
        if (s.hi - s.lo + 1 > 200) {
          nodes.push(el("div", { className: "meta" },
            document.createTextNode("Showing first 200 entries. "),
            el("a", { href: "#seq=" + s.lo, textContent: "View in timeline" })));
        }
        kids.replaceChildren(...nodes);
      } catch (e) {
        kids.replaceChildren(el("div", { className: "meta e", textContent: "Error: " + e.message }));
        kids = null;
        btn.setAttribute("aria-expanded", "false");
      }
    };
    $main.append(row);
  }
  if (!summaries.length) $main.append(el("div", { className: "empty", textContent: "No summaries yet." }));
  doneLoading();
}

function hl(text, query) {
  const frag = document.createDocumentFragment();
  const raw = query.trim();
  if (!raw || !text) { frag.append(document.createTextNode(text || "")); return frag; }
  let terms = raw.split(/[^\\p{L}\\p{N}_-]+/u).filter((t) => t.length >= 2);
  if (!terms.length) terms = [raw];
  terms = [...new Set(terms)].sort((a, b) => b.length - a.length).slice(0, 10);
  const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^$|()\\[\\]{}\\\\]/g, "\\\\$&")).join("|") + ")", "gi");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    frag.append(el("mark", { textContent: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

async function search(q, token) {
  setLoading("Searching...");
  const r = await api("search?q=" + encodeURIComponent(q));
  if (token !== navToken) return;
  $main.replaceChildren(el("h2", { textContent: "Memories (" + r.memories.length + ")" }));
  if (r.memoryError) $main.append(el("div", { className: "empty", textContent: r.memoryError }));
  for (const line of r.memories) {
    const m = line.match(/^#(\\d+)\\s+\\[([^\\]]+)\\]\\s*(.*)$/);
    if (m) {
      $main.append(el("div", { className: "hit hit-mem" },
        el("a", { className: "seq", href: "#seq=" + m[1], textContent: "#" + m[1], title: "View in timeline" }),
        el("div", {}, el("div", {}, hl(m[3], q)), el("div", { className: "meta", textContent: m[2] }))));
    } else {
      $main.append(el("div", { className: "hit" }, hl(line, q)));
    }
  }
  if (!r.memories.length && !r.memoryError) $main.append(el("div", { className: "empty", textContent: "No memories found." }));
  $main.append(el("h2", { textContent: "Notes (" + r.notes.length + ")" }));
  if (r.notesError) $main.append(el("div", { className: "empty", textContent: r.notesError }));
  for (const n of r.notes) $main.append(el("div", { className: "hit" },
    el("a", { href: "#note=" + encodeURIComponent(n.path) }, hl(n.path, q)),
    el("span", { className: "meta", textContent: "  " + n.matched }),
    el("div", { className: "snip" }, hl(n.text.slice(0, 300), q))));
  if (!r.notes.length && !r.notesError) $main.append(el("div", { className: "empty", textContent: "No notes found." }));
  doneLoading();
}

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
async function health(hours, token, quiet = false) {
  lastHealthHours = hours;
  clearHealthTimer();
  if (!quiet) setLoading("Loading health...");
  const d = await api("health?hours=" + hours);
  if (token !== navToken) return;
  const tools = d.totals.filter((r) => r.kind === "tool"), clients = d.totals.filter((r) => r.kind === "client");
  const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const calls = sum(tools, "ok") + sum(tools, "err"), errs = sum(tools, "err"), rl = sum(d.totals.filter((r) => r.kind !== "client"), "rate_limited");
  const svcErr = sum(d.totals.filter((r) => r.kind === "service"), "err");
  const unauth = sum(d.totals.filter((r) => r.kind === "http" && r.name === "mcp_unauthorized"), "ok");
  const avg = calls ? Math.round(sum(tools, "total_ms") / calls) + " ms" : "-";
  const seg = el("div", { className: "seg" }, ...[[24, "24h"], [168, "7d"], [720, "30d"]].map(([h, l]) => {
    const b = el("button", { type: "button", className: "btn" + (h === hours ? " on" : ""), textContent: l, onclick: () => (location.hash = "health=" + h) });
    b.setAttribute("aria-pressed", String(h === hours));
    return b;
  }));
  const refBtn = el("button", { type: "button", className: "btn sm", textContent: "Refresh" });
  refBtn.onclick = async () => {
    refBtn.disabled = true;
    refBtn.textContent = "Refreshing...";
    try { await health(hours, token, true); }
    catch { refBtn.disabled = false; refBtn.textContent = "Refresh"; }
  };
  const autoBtn = el("button", { type: "button", className: "btn sm" + (healthAuto ? " on" : ""), textContent: healthAuto ? "Auto: on" : "Auto: off" });
  autoBtn.setAttribute("aria-pressed", String(healthAuto));
  autoBtn.onclick = () => {
    healthAuto = !healthAuto;
    autoBtn.classList.toggle("on", healthAuto);
    autoBtn.textContent = healthAuto ? "Auto: on" : "Auto: off";
    autoBtn.setAttribute("aria-pressed", String(healthAuto));
    clearHealthTimer();
    if (healthAuto) healthTimer = setInterval(() => { if (!document.hidden && tab === "health") health(hours, navToken, true); }, 30000);
  };
  const head = el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap" },
    el("div", { className: "stats", style: "margin:0", textContent: "Since " + new Date(d.since).toLocaleString() }),
    el("div", { className: "h-ctl" }, seg, refBtn, autoBtn));
  const out = [head, el("div", { className: "tiles" },
    tile("MCP tool calls", nf(calls)),
    tile("Tool errors (" + pct(errs, calls) + ")", nf(errs), errs ? "bad" : ""),
    tile("Rate-limited (429 / quota)", nf(rl), rl ? "warn" : ""),
    tile("Background API errors", nf(svcErr), svcErr ? "bad" : ""),
    tile("Avg tool latency", avg),
    tile("Open alerts", nf(d.openAlerts.length), d.openAlerts.length ? "bad" : ""),
    tile("Unauthorized /mcp hits", nf(unauth)))];
  out.push(el("div", { className: "card" }, el("h3", { textContent: "Tool calls over time" }),
    el("div", { className: "legend" }, el("span", {}, el("i", { style: "background:var(--ok)" }), "ok"), el("span", {}, el("i", { style: "background:var(--err)" }), "error")), chart(d.series, hours)));
  const lat = (r) => { const c = Number(r.ok) + Number(r.err); return c ? Math.round(r.total_ms / c) + " ms" : "-"; };
  const cols = (label) => [
    { h: label, v: (r) => r.name }, { h: "Calls", n: 1, v: (r) => nf(Number(r.ok) + Number(r.err)) },
    { h: "Errors", n: 1, v: (r) => nf(r.err), cls: (r) => (r.err ? "e" : "") }, { h: "Error rate", n: 1, v: (r) => pct(r.err, Number(r.ok) + Number(r.err)) },
    { h: "Rate-limited", n: 1, v: (r) => nf(r.rate_limited), cls: (r) => (r.rate_limited ? "w" : "") }, { h: "Avg latency", n: 1, v: lat }];
  out.push(el("div", { className: "card" }, el("h3", { textContent: "By tool" }), table(cols("Tool"), tools)));
  out.push(el("div", { className: "card" }, el("h3", { textContent: "By client" }), table(cols("Client"), clients)));
  const svcTotals = (name) => d.totals.find((r) => r.kind === "service" && r.name === name) || { ok: 0, err: 0, rate_limited: 0, total_ms: 0 };
  const svcRows = [["Embeddings", "embedding", d.services.embedding], ["Memory summaries", "memory-summary", d.services.memorySummary]].map(([label, key, s]) => ({ label, s, t: svcTotals(key) }));
  const status = (s) => { const state = s.disabled || s.provider === "none" ? ["disabled", "var(--muted)"] : s.consecutiveFailures ? [s.lastRateLimited ? "rate-limited" : "failing", s.lastRateLimited ? "var(--warn)" : "var(--err)"] : ["healthy", "var(--ok)"]; return el("span", {}, el("span", { className: "dot", style: "background:" + state[1] }), state[0]); };
  out.push(el("div", { className: "card" }, el("h3", { textContent: "Background APIs" }), table([
    { h: "Service", v: (r) => r.label }, { h: "Provider", v: (r) => (r.s.provider || "-") + (r.s.model ? " / " + r.s.model : "") }, { h: "Status", v: (r) => status(r.s) },
    { h: "Calls", n: 1, v: (r) => nf(Number(r.t.ok) + Number(r.t.err)) }, { h: "Errors", n: 1, v: (r) => nf(r.t.err), cls: (r) => (r.t.err ? "e" : "") },
    { h: "Rate-limited", n: 1, v: (r) => nf(r.t.rate_limited), cls: (r) => (r.t.rate_limited ? "w" : "") }, { h: "Avg latency", n: 1, v: (r) => lat(r.t) },
    { h: "Last success", v: (r) => ago(r.s.lastSuccessAt) }], svcRows),
    d.services.memorySummary.pendingCompactions ? el("div", { className: "meta", style: "margin-top:6px", textContent: d.services.memorySummary.pendingCompactions + " memory compactions pending" }) : ""));
  if (d.openAlerts.length) out.push(el("div", { className: "card" }, el("h3", { textContent: "Open alerts" }), table([
    { h: "When", v: (r) => ago(r.created_at) }, { h: "Source", v: (r) => r.source }, { h: "Detail", v: (r) => { try { const j = JSON.parse(r.body); return (j.rateLimited ? "[rate limit] " : "") + (j.error || r.body); } catch { return r.body; } } }], d.openAlerts)));
  out.push(el("div", { className: "card" }, el("h3", { textContent: "Recent errors" }), table([
    { h: "When", v: (r) => ago(r.at) }, { h: "Where", v: (r) => r.kind + ": " + r.name },
    { h: "Type", v: (r) => (r.rate_limited ? "rate limit" : "error"), cls: (r) => (r.rate_limited ? "w" : "e") }, { h: "Message", v: (r) => r.message }], d.errors)));
  $main.replaceChildren(...out);
  doneLoading();
  if (healthAuto) healthTimer = setInterval(() => { if (!document.hidden && tab === "health") health(hours, navToken, true); }, 30000);
}

function go(t) { location.hash = t; }
async function route() {
  const token = ++navToken;
  clearHealthTimer();
  let h = "";
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { h = location.hash.slice(1); }
  if (h.startsWith("q=")) {
    const qv = h.slice(2);
    if (document.activeElement !== $q || !$q.value.trim()) $q.value = qv;
  } else if (document.activeElement !== $q) {
    $q.value = "";
  }
  try {
    if (h.startsWith("note=")) { setTab("notes"); await notes(h.slice(5), token); }
    else if (h.startsWith("q=")) { setTab(""); await search(h.slice(2), token); }
    else if (h === "notes") { setTab("notes"); await notes("", token); }
    else if (h.startsWith("health")) { setTab("health"); await health(Number(h.split("=")[1]) || lastHealthHours, token); }
    else if (h === "tree") { setTab("tree"); await tree(token); }
    else if (h.startsWith("seq=")) { setTab("timeline"); const rawSeq = h.slice(4); const seq = rawSeq.trim() === "" ? NaN : Number(rawSeq); await timeline(Number.isInteger(seq) && seq >= 0 ? seq : null, token); }
    else { setTab("timeline"); await timeline(null, token); }
  } catch (e) {
    if (token !== navToken || e.message === "unauthorized") return;
    doneLoading();
    $main.replaceChildren(el("div", { className: "empty" },
      el("div", { textContent: "Error: " + e.message }),
      el("button", { type: "button", className: "btn more", textContent: "Retry", onclick: route })));
  }
}

let t;
$q.addEventListener("input", (e) => {
  clearTimeout(t);
  const v = e.target.value.trim();
  t = setTimeout(() => {
    if (v) location.hash = "q=" + encodeURIComponent(v);
    else if (location.hash.startsWith("#q=")) location.hash = lastTab;
  }, 300);
});
$q.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(t);
    const v = $q.value.trim();
    const next = v ? "q=" + encodeURIComponent(v) : lastTab;
    if (location.hash.slice(1) === next) route();
    else location.hash = next;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    $q.focus();
    $q.select();
  } else if (e.key === "Escape") {
    const nfEl = document.getElementById("note-filter");
    if (document.activeElement === nfEl) {
      if (nfEl.value) { nfEl.value = ""; nfEl.dispatchEvent(new Event("input")); }
      else nfEl.blur();
    } else if (document.activeElement === $q) {
      clearTimeout(t);
      if ($q.value) { $q.value = ""; if (location.hash.startsWith("#q=")) go(lastTab); }
      else $q.blur();
    } else if (location.hash.startsWith("#q=")) {
      clearTimeout(t);
      $q.value = "";
      go(lastTab);
    }
  }
});
addEventListener("hashchange", route);
route();
</script></body></html>`;
