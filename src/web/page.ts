// Static HTML for the web viewer. All dynamic text is inserted with textContent;
// note Markdown is rendered with marked and sanitized with DOMPurify.

const STYLE = `
:root{--bg:#f7f4ee;--panel:#fffdf8;--ink:#1f2328;--muted:#6b6f76;--line:#e4ddd0;--accent:#b4442f;--chip:#efe8db;--code:#f1ece2}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--panel:#1b2026;--ink:#e6e3dc;--muted:#9097a0;--line:#2b323a;--accent:#e2775f;--chip:#252c34;--code:#222930}}
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
  <nav><button data-tab="timeline" class="on">Memories</button><button data-tab="notes">Notes</button><button data-tab="tree">Summaries</button></nav>
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

function go(t) { location.hash = t; }
async function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  try {
    if (h.startsWith("note=")) { setTab("notes"); await notes(h.slice(5)); }
    else if (h.startsWith("q=")) { setTab(""); await search(h.slice(2)); }
    else if (h === "notes") { setTab("notes"); await notes(); }
    else if (h === "tree") { setTab("tree"); await tree(); }
    else { setTab("timeline"); await timeline(); }
  } catch (e) { if (e.message !== "unauthorized") $main.replaceChildren(el("div", { className: "empty", textContent: "Error: " + e.message })); }
}
let t;
document.getElementById("q").addEventListener("input", (e) => { clearTimeout(t); const v = e.target.value.trim(); t = setTimeout(() => { location.hash = v ? "q=" + encodeURIComponent(v) : "timeline"; }, 300); });
addEventListener("hashchange", route);
route();
</script></body></html>`;
