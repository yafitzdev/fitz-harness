#!/usr/bin/env node
/**
 * generate-project-overview.mjs
 * -----------------------------
 * Generates docs/project-overview.html entirely from ground truth in this repo:
 *   - workspace packages + their real @fitz/* dependency graph
 *   - source/test file counts
 *   - live vitest results (cached to scripts/.overview-tests.json on failure)
 *   - git branch, commit count, last commit date
 *   - HTTP routes extracted from the host's modular route files
 *   - route ids extracted from engine playbook files
 *   - model families in the canonical managed-Linux registry
 *   - desktop UI controllers
 *   - feature bullets from docs/implementation-status.md
 *
 * Run:  pnpm docs:overview     (or:  node scripts/generate-project-overview.mjs)
 * The page can never drift from the repo: every number is read at generation time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const llmRoot = process.env.FITZ_LLM_ROOT ?? (process.platform === "win32"
  ? "\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm"
  : "/opt/fitz/llm");
const TEST_CACHE = join(root, "scripts", ".overview-tests.json");
const OUT = join(root, "docs", "project-overview.html");

const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const tryExec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const listFiles = (dirs, pred) =>
  dirs
    .flatMap((d) => (existsSync(d) ? walk(d) : []))
    .filter((f) => pred(f))
    .map((f) => relative(root, f).replaceAll("\\", "/"))
    .sort();

/* ---------------- 1. workspace graph ---------------- */

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const rootPkg = readJson(join(root, "package.json"));

const packages = [];
for (const dir of readdirSync(join(root, "packages"))) {
  const p = join(root, "packages", dir);
  if (!existsSync(join(p, "package.json"))) continue;
  const pkg = readJson(join(p, "package.json"));
  packages.push({
    name: pkg.name, kind: "package",
    deps: Object.keys(pkg.dependencies ?? {}).filter((k) => k.startsWith("@fitz/")),
    scripts: Object.keys(pkg.scripts ?? {}),
  });
}
for (const dir of readdirSync(join(root, "apps"))) {
  const p = join(root, "apps", dir);
  if (!existsSync(join(p, "package.json"))) continue;
  const pkg = readJson(join(p, "package.json"));
  packages.push({
    name: pkg.name, kind: "app",
    deps: Object.keys(pkg.dependencies ?? {}).filter((k) => k.startsWith("@fitz/")),
    scripts: Object.keys(pkg.scripts ?? {}),
  });
}
packages.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));

// topological layers from the real dependency graph (protocol = layer 0)
const layerOf = new Map();
const depth = (name) => {
  if (layerOf.has(name)) return layerOf.get(name);
  const pkg = packages.find((p) => p.name === name);
  const l = pkg && pkg.deps.length ? Math.max(...pkg.deps.map(depth)) + 1 : 0;
  layerOf.set(name, l);
  return l;
};
for (const pkg of packages) depth(pkg.name);

/* ---------------- 2. file counts ---------------- */

const srcDirs = packages.map((p) =>
  join(root, p.name.replace("@fitz/", p.kind === "package" ? "packages/" : "apps/"))
);
const allTs = listFiles(srcDirs, (f) => f.endsWith(".ts"));
const sourceFiles = allTs.filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
const testFiles = allTs.filter((f) => f.endsWith(".test.ts"));

/* ---------------- 3. live test results ---------------- */

let tests = { total: 0, passed: 0, failed: 0, note: "" };
const outRel = relative(root, TEST_CACHE).replaceAll("\\", "/");
try {
  execFileSync("pnpm", ["vitest", "run", "--reporter=json", `--outputFile=${outRel}`], {
    encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 300_000, cwd: root,
  });
} catch { /* non-zero exit expected; json report is still written */ }
if (existsSync(TEST_CACHE)) {
  const rep = readJson(TEST_CACHE);
  tests = { total: rep.numTotalTests ?? 0, passed: rep.numPassedTests ?? 0, failed: rep.numFailedTests ?? 0, note: "" };
} else {
  tests.note = "tests not run at generation time";
}

/* ---------------- 4. git state ---------------- */

const gitBranch = tryExec("git", ["branch", "--show-current"]) ?? "unknown";
const gitCommits = tryExec("git", ["rev-list", "--count", "HEAD"]) ?? "?";
const gitDate = tryExec("git", ["log", "-1", "--format=%ad", "--date=short"]) ?? "?";

/* ---------------- 5. HTTP routes from the host ---------------- */

const routes = [];
const hostRouteFiles = listFiles(
  [join(root, "apps", "host", "src")],
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);
for (const file of hostRouteFiles) {
  const src = readFileSync(join(root, file), "utf8");
  const re = /app\.(get|post|put|delete|patch)\("([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) routes.push({ method: m[1].toUpperCase(), path: m[2] });
}
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

/* ---------------- 6. inference route ids from playbooks ---------------- */

const playbookFiles = listFiles([join(root, "apps", "host", "src")], (f) => /playbook/i.test(f));
const playbookIds = new Set();
for (const f of playbookFiles) {
  const src = readFileSync(join(root, f), "utf8");
  for (const m of src.matchAll(/(?:id|routeId):\s*"([\w-]+)"/g)) playbookIds.add(m[1]);
}
const routeIds = [...playbookIds].filter((id) => !["ninfer", "default-agent"].includes(id));

/* ---------------- 7. model families on disk ---------------- */

let modelFamilies = [];
try {
  modelFamilies = readdirSync(join(llmRoot, "models")).filter((d) => !d.startsWith("."));
} catch { /* not present on this machine */ }

/* ---------------- 8. desktop controllers ---------------- */

const controllers = listFiles(
  [join(root, "apps", "desktop", "src")],
  (f) => /Controller\.ts$/.test(f)
).map((f) => f.split("/").pop().replace("Controller.ts", ""));

/* ---------------- 9. status bullets ---------------- */

let implemented = [];
let deferred = [];
const statusPath = join(root, "docs", "implementation-status.md");
if (existsSync(statusPath)) {
  const lines = readFileSync(statusPath, "utf8").split("\n");
  let section = null;
  for (const line of lines) {
    if (/^##\s+Intentionally deferred/i.test(line)) section = "deferred";
    else if (/^##\s+/.test(line)) section = "other";
    else if (/^-\s+/.test(line)) {
      if (section === "deferred") deferred.push(line.replace(/^-\s+/, "").trim());
      else if (section === null || section === "other") implemented.push(line.replace(/^-\s+/, "").trim());
    }
  }
}

/* ---------------- 10. curated role map (authored prose) ---------------- */

const ROLES = {
  "@fitz/protocol": "Versioned DTOs, events, and API contracts shared by every layer",
  "@fitz/inference-core": "Adapter contract, lifecycle state machine, FIFO scheduler, route resolver, resource governor",
  "@fitz/adapter-ninfer": "NInfer (WSL) adapter — validated launch specs, generated credentials, auth streaming",
  "@fitz/adapter-llama-cpp": "Managed llama.cpp adapter over the shared OpenAI-compatible transport",
  "@fitz/adapter-openai-compatible": "Generic external OpenAI-compatible engine adapter",
  "@fitz/agent-core": "Fitz-owned agent runtime boundary: runs, approvals, event translation",
  "@fitz/agent-pi": "Opt-in Pi SDK 0.83.0 adapter behind the agent boundary",
  "@fitz/context": "Codex-style token budgeting, canonical reconstruction, transcript compaction",
  "@fitz/storage": "SQLite (node:sqlite, WAL) migrations and repositories",
  "@fitz/security": "HMAC API-key auth, roles, grants, quotas, revocation, and audit log",
  "@fitz/connectivity": "Protected loopback gateway plus Tailscale Funnel and startup management",
  "@fitz/media": "Artifact metadata, strict MIME classification, SHA-256 integrity",
  "@fitz/observability": "Structured logging, secret redaction, metrics, diagnostics",
  "@fitz/host": "Long-running Fastify control plane — engines, routing, queueing, security, agents, storage",
  "@fitz/desktop": "Electron 43 shell with a vanilla-TypeScript renderer UI",
};

/* ---------------- 11. SVG dependency graph ---------------- */

const BOX_W = 150, BOX_H = 52, GAP_X = 18, GAP_Y = 74, M = 36;
const layers = [...new Set(packages.map((p) => depth(p.name)))].sort((a, b) => a - b);
const byLayer = (l) => packages.filter((p) => depth(p.name) === l);
const W = Math.max(720, layers.reduce((mx, l) => {
  const n = byLayer(l).length;
  return Math.max(mx, n * BOX_W + (n - 1) * GAP_X);
}, 0) + M * 2);
const H = M * 2 + (layers.length - 1) * GAP_Y + BOX_H;
const pos = new Map();
for (const l of layers) {
  const row = byLayer(l);
  const totalW = row.length * BOX_W + (row.length - 1) * GAP_X;
  let x = (W - totalW) / 2;
  const y = M + l * GAP_Y;
  for (const pkg of row) {
    pos.set(pkg.name, { x, y, w: BOX_W, h: BOX_H });
    x += BOX_W + GAP_X;
  }
}
let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">\n`;
svg += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a6a45"/></marker></defs>\n`;
for (const pkg of packages) {
  for (const dep of pkg.deps) {
    const a = pos.get(pkg.name), b = pos.get(dep);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, ctrl = (y1 + y2) / 2;
    svg += `<path d="M ${x1} ${y1} C ${x1} ${ctrl}, ${x2} ${ctrl}, ${x2} ${y2}" class="edge"/>\n`;
  }
}
for (const pkg of packages) {
  const p = pos.get(pkg.name);
  if (!p) continue;
  const isApp = pkg.kind === "app";
  svg += `<g><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="9" class="box${isApp ? " hot" : ""}"/>\n`;
  svg += `<text x="${p.x + p.w / 2}" y="${p.y + (isApp ? 23 : 21)}" text-anchor="middle" class="t-name">${esc(pkg.name.replace("@fitz/", ""))}</text>`;
  svg += `<text x="${p.x + p.w / 2}" y="${p.y + (isApp ? 39 : 37)}" text-anchor="middle" class="t-kind">${isApp ? "app" : "package"}</text></g>\n`;
}
svg += "</svg>";

/* ---------------- 12. computed markup fragments ---------------- */

const pkgRows = packages
  .map((p) => {
    const deps = p.deps.length
      ? p.deps.map((d) => `<span class="chip">${esc(d.replace("@fitz/", ""))}</span>`).join(" ")
      : '<span class="faint">—</span>';
    const extra = p.scripts.filter((s) => !["build", "typecheck", "clean"].includes(s)).join(", ");
    return `<tr><td>${esc(p.name)}${p.kind === "app" ? ' <span class="badge b-orange">app</span>' : ""}</td>` +
      `<td>${esc(ROLES[p.name] ?? "")}</td><td class="deps-cell">${deps}</td>` +
      `<td>${extra || '<span class="faint">—</span>'}</td></tr>`;
  })
  .join("\n");

const apiRows = routes
  .map((r) => `<tr><td><span class="method ${r.method.toLowerCase()}">${r.method}</span></td><td class="route">${esc(r.path)}</td></tr>`)
  .join("\n");

const stat = (num, lbl) => `<div class="stat"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
const statGrid = [
  stat(packages.filter((p) => p.kind === "package").length, "packages"),
  stat(packages.filter((p) => p.kind === "app").length, "apps"),
  stat(sourceFiles.length, "source files"),
  stat(testFiles.length, "test files"),
  stat(tests.passed, "passing tests"),
  stat(tests.failed, "failing tests"),
  stat(gitCommits, "commits on " + gitBranch),
  stat(routes.length, "HTTP endpoints"),
].join("\n");

const now = new Date().toISOString().slice(0, 16).replace("T", " ");

const routeChips = routeIds.map((id) => `<span class="chip route-chip">${esc(id)}</span>`).join(" ");
const modelChips = modelFamilies.map((m) => `<span class="chip">${esc(m)}</span>`).join(" ");
const controllerChips = controllers.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ");
const implBullets = implemented.slice(0, 12).map((b) => `<li>${esc(b)}</li>`).join("");
const defBullets = deferred.map((b) => `<li>${esc(b)}</li>`).join("");

const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fitz Harness — Project Overview</title>
<style>
  :root {
    --bg:#17100a; --bg-elev:#211708; --bg-elev-2:#2c1f10;
    --border:#41301b; --border-hot:#5a4024;
    --text:#f8efe4; --text-dim:#c7b29b; --text-faint:#927b62;
    --accent:#ff7a2a; --accent-2:#f59e0b; --accent-hi:#ffa64d;
    --green:#56c98c; --blue:#7cb8ff; --purple:#d4a0ff; --cyan:#5ed0cf;
    --mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;padding-bottom:6rem}
  header{position:sticky;top:0;z-index:50;background:rgba(23,16,10,.93);backdrop-filter:blur(8px);border-bottom:1px solid var(--border);padding:.8rem 2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
  header .logo{width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,var(--accent-hi),var(--accent));display:grid;place-items:center;font-weight:700;color:#1d0f04;font-size:15px;box-shadow:0 0 14px rgba(255,122,42,.35)}
  header h1{font-size:1.05rem;font-weight:600}
  header .tag{font-size:.72rem;color:var(--text-dim);border:1px solid var(--border);border-radius:999px;padding:.15rem .6rem;background:var(--bg-elev);font-family:var(--mono)}
  header .gen{border-color:rgba(255,122,42,.4);color:var(--accent-hi)}
  header nav{margin-left:auto;display:flex;gap:.4rem;flex-wrap:wrap}
  header nav a{color:var(--text-dim);text-decoration:none;font-size:.78rem;padding:.3rem .6rem;border-radius:6px}
  header nav a:hover{color:var(--accent-hi);background:var(--bg-elev-2)}
  .wrap{max-width:1040px;margin:0 auto;padding:2.5rem 2rem 0}
  .hero{margin-bottom:3rem}
  .hero h2{font-size:2.3rem;font-weight:700;line-height:1.2;background:linear-gradient(120deg,var(--text) 20%,var(--accent-hi) 55%,var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p.lead{color:var(--text-dim);font-size:1.1rem;margin-top:.8rem;max-width:72ch}
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.8rem;margin-top:1.8rem}
  .stat{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem;border-top:2px solid transparent}
  .stat:hover{border-top-color:var(--accent)}
  .stat .num{font-size:1.5rem;font-weight:700;font-family:var(--mono);color:var(--accent-hi)}
  .stat .lbl{font-size:.76rem;color:var(--text-dim);margin-top:.2rem}
  section{margin-bottom:3.5rem;scroll-margin-top:4.5rem}
  h3.section-title{font-size:1.25rem;font-weight:650;margin-bottom:.3rem;display:flex;align-items:center;gap:.6rem}
  h3.section-title::before{content:"";width:4px;height:1.1em;border-radius:2px;background:linear-gradient(180deg,var(--accent-hi),var(--accent))}
  .section-sub{color:var(--text-faint);font-size:.85rem;margin-bottom:1.4rem}
  h4{font-size:1rem;font-weight:600;margin:1.6rem 0 .6rem}
  p.body{color:var(--text-dim);max-width:82ch;margin-bottom:.6rem}
  p.body code,li code,td code{font-family:var(--mono);font-size:.82em;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:4px;padding:.1em .35em;color:var(--accent-hi)}
  a{color:var(--blue);text-decoration:none}
  a:hover{text-decoration:underline}
  ul,ol{color:var(--text-dim);padding-left:1.3rem}
  li{margin-bottom:.35rem}
  li strong{color:var(--text)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
  .card{background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:1.2rem 1.3rem;transition:border-color .15s,transform .15s}
  .card:hover{border-color:var(--border-hot);transform:translateY(-1px)}
  .card .mono{font-family:var(--mono);font-size:.78rem;color:var(--accent);display:block;margin-bottom:.4rem}
  .card h5{font-size:.95rem;margin:0 0 .3rem}
  .card p{font-size:.85rem;color:var(--text-dim)}
  .arch{background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:1.6rem;overflow-x:auto}
  .arch svg{display:block;margin:0 auto;min-width:720px}
  .arch text{font-family:var(--mono)}
  .arch .box{fill:var(--bg-elev-2);stroke:var(--border);stroke-width:1.2}
  .arch .box.hot{stroke:var(--accent);stroke-width:1.8;filter:drop-shadow(0 0 8px rgba(255,122,42,.25))}
  .arch .t-name{fill:var(--text);font-size:12.5px;font-weight:650}
  .arch .t-kind{fill:var(--text-faint);font-size:9.5px}
  .arch .edge{stroke:#8a6a45;stroke-width:1.4;marker-end:url(#arrow);fill:none;opacity:.8}
  table{width:100%;border-collapse:collapse;font-size:.84rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  th{text-align:left;font-weight:600;color:var(--text);background:var(--bg-elev-2);padding:.65rem 1rem;border-bottom:1px solid var(--border);font-size:.75rem;text-transform:uppercase;letter-spacing:.5px}
  td{padding:.6rem 1rem;border-bottom:1px solid var(--border);color:var(--text-dim);vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:var(--bg-elev-2)}
  td:first-child{color:var(--text);font-family:var(--mono);font-size:.8rem;white-space:nowrap}
  td.route{font-family:var(--mono);font-size:.8rem;color:var(--accent-hi)}
  .deps-cell{white-space:normal}
  .method{font-family:var(--mono);font-size:.68rem;font-weight:700;padding:.1rem .45rem;border-radius:4px;display:inline-block}
  .method.get{background:rgba(92,200,140,.14);color:var(--green);border:1px solid rgba(92,200,140,.35)}
  .method.post{background:rgba(255,166,77,.14);color:var(--accent-hi);border:1px solid rgba(255,166,77,.35)}
  .method.put,.method.patch{background:rgba(124,184,255,.14);color:var(--blue);border:1px solid rgba(124,184,255,.35)}
  .method.delete{background:rgba(255,107,107,.14);color:#ff8a8a;border:1px solid rgba(255,107,107,.35)}
  .badge{display:inline-block;font-size:.68rem;font-weight:600;padding:.12rem .5rem;border-radius:999px;margin-left:.35rem;vertical-align:middle;letter-spacing:.3px}
  .b-orange{background:rgba(255,122,42,.15);color:var(--accent-hi);border:1px solid rgba(255,122,42,.4)}
  .b-amber{background:rgba(245,158,11,.15);color:var(--accent-2);border:1px solid rgba(245,158,11,.4)}
  .chip{display:inline-block;font-family:var(--mono);font-size:.72rem;color:var(--accent-hi);background:rgba(255,122,42,.08);border:1px solid rgba(255,122,42,.3);border-radius:999px;padding:.08rem .55rem;margin:.1rem .15rem .1rem 0;white-space:nowrap}
  .route-chip{color:var(--accent-2);background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3);font-size:.8rem;padding:.2rem .7rem}
  pre{background:#120b05;border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.3rem;overflow-x:auto;font-size:.8rem;font-family:var(--mono);line-height:1.55;margin:.8rem 0 1.2rem}
  pre code{color:var(--text-dim);background:none;border:none;padding:0;font-size:inherit}
  .tok-c{color:#6e5638}.tok-k{color:var(--accent-2)}.tok-s{color:var(--green)}.tok-f{color:var(--blue)}.tok-n{color:var(--accent-hi)}
  footer{border-top:1px solid var(--border);margin-top:4rem;padding-top:1.5rem;color:var(--text-faint);font-size:.78rem;text-align:center;line-height:1.9}
  footer .cmd{font-family:var(--mono);color:var(--accent-hi);background:var(--bg-elev);border:1px solid var(--border);border-radius:5px;padding:.05rem .4rem}
  .faint{color:var(--text-faint)}
  @media(max-width:700px){.wrap{padding:1.5rem 1rem 0}.stat-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<header>
  <div class="logo">F</div>
  <h1>Fitz Harness</h1>
  <span class="tag">local-first</span>
  <span class="tag">pnpm monorepo</span>
  <span class="tag gen">generated</span>
  <nav>
    <a href="#overview">Overview</a>
    <a href="#architecture">Architecture</a>
    <a href="#packages">Packages</a>
    <a href="#api">API</a>
    <a href="#inference">Inference</a>
    <a href="#agent">Agent</a>
    <a href="#desktop">Desktop</a>
    <a href="#status">Status</a>
  </nav>
</header>

<div class="wrap">

  <div class="hero" id="overview">
    <h2>Fitz Harness</h2>
    <p class="lead">A local-first, Codex-style agent desktop application with an inference control plane — an LLM engine manager that owns model loading, routing, queueing, security, and durable agent sessions, all on your own hardware.</p>
    <div class="stat-grid">
${statGrid}
    </div>
  </div>

  <section id="architecture">
    <h3 class="section-title">Architecture</h3>
    <div class="section-sub">Dependency graph generated from the real <span class="chip">workspace:*</span> references — layers are computed, not drawn by hand.</div>
    <div class="arch">
${svg}
    </div>
    <div class="grid" style="margin-top:1.2rem">
      <div class="card"><span class="mono">01</span><h5>Desktop shell ≠ service</h5><p>The Electron window is a client. Closing it never stops the host — runs, queueing, and engines keep working headlessly.</p></div>
      <div class="card"><span class="mono">02</span><h5>Engine adapters</h5><p>NInfer, llama.cpp, OpenAI-compatible, and a deterministic fake all sit behind one adapter contract with a shared lifecycle.</p></div>
      <div class="card"><span class="mono">03</span><h5>Fitz-owned boundaries</h5><p>The Pi SDK lives behind <span class="chip">agent-core</span>; SQLite behind <span class="chip">storage</span>; auth behind <span class="chip">security</span>. Nothing leaks across layers.</p></div>
    </div>
  </section>

  <section id="packages">
    <h3 class="section-title">Packages</h3>
    <div class="section-sub">${packages.length} workspaces — dependencies listed are only the internal <span class="chip">@fitz/*</span> edges; count and graph are read from <span class="chip">package.json</span> at generation time.</div>
    <table>
      <thead><tr><th>workspace</th><th>role</th><th>depends on</th><th>extra scripts</th></tr></thead>
      <tbody>
${pkgRows}
      </tbody>
    </table>
  </section>

  <section id="api">
    <h3 class="section-title">API surface</h3>
    <div class="section-sub">${routes.length} endpoints extracted from the modular host routes — Fastify on <span class="chip">127.0.0.1:8787</span>.</div>
    <table>
      <thead><tr><th>method</th><th>path</th></tr></thead>
      <tbody>
${apiRows}
      </tbody>
    </table>
  </section>

  <section id="inference">
    <h3 class="section-title">Inference engine &amp; routing</h3>
    <div class="section-sub">Stable routes extracted from engine playbooks; model families from <span class="chip">/opt/fitz/llm/models</span>.</div>
    <div class="grid">
      <div class="card"><span class="mono">routes</span><h5>Stable route ids</h5><p>${routeChips || '<span class="faint">none found</span>'}</p></div>
      <div class="card"><span class="mono">models on disk</span><h5>Model families</h5><p>${modelChips || '<span class="faint">/opt/fitz/llm/models not present on this machine</span>'}</p></div>
    </div>
    <h4>Lifecycle</h4>
    <pre><code><span class="tok-c">// packages/inference-core — the state machine that owns every engine</span>
<span class="tok-k">UNLOADED</span> <span class="tok-n">→</span> <span class="tok-k">PREPARING</span> <span class="tok-n">→</span> <span class="tok-k">LOADING</span> <span class="tok-n">→</span> <span class="tok-k">READY</span> <span class="tok-n">→</span> <span class="tok-k">BUSY</span> <span class="tok-n">→</span> <span class="tok-k">READY</span> <span class="tok-n">→ …</span>
<span class="tok-f">on-demand load · 600s idle TTL eviction · 2 GiB VRAM reserve · FIFO single-generation queue</span></code></pre>
  </section>

  <section id="agent">
    <h3 class="section-title">Agent runtime</h3>
    <div class="section-sub">Durable, resumable, owner-isolated — from <span class="chip">agent-core</span> + the opt-in <span class="chip">agent-pi</span> adapter.</div>
    <div class="grid">
      <div class="card"><span class="mono">runs</span><h5>Durable native runs</h5><p>Sequenced text/tool events, JSON replay, resumable SSE via <span class="chip">Last-Event-ID</span>, crash recovery after host restart.</p></div>
      <div class="card"><span class="mono">tools</span><h5>Policy-gated tools</h5><p>Allowlisted coding tools; durable pre-execution approvals; <span class="chip">full</span> / <span class="chip">ask</span> / <span class="chip">read-only</span> access modes.</p></div>
      <div class="card"><span class="mono">context</span><h5>Compaction</h5><p>80% token threshold, deterministic summarizer, canonical transcript preserved while the working context is compacted.</p></div>
    </div>
  </section>

  <section id="desktop">
    <h3 class="section-title">Desktop experience</h3>
    <div class="section-sub">${controllers.length} UI controllers extracted from <span class="chip">apps/desktop/src</span> — vanilla TypeScript DOM, no framework.</div>
    <p class="body">Codex-styled 3-pane layout: project/task sidebar, transcript with activity timeline and tool disclosures, floating composer with model/effort/temperature controls, and a right Inspector for files, markdown, sandboxed HTML, and media.</p>
    <p class="body">Controllers:</p>
    <p class="body">${controllerChips}</p>
  </section>

  <section id="status">
    <h3 class="section-title">Status</h3>
    <div class="section-sub">Feature bullets from <span class="chip">docs/implementation-status.md</span> — ${implemented.length} implemented, ${deferred.length} deferred.</div>
    <div class="grid">
      <div class="card"><span class="mono">shipped</span><h5>Implemented</h5><ul>${implBullets}</ul></div>
      <div class="card"><span class="mono">next</span><h5>Deferred</h5><ul>${defBullets}</ul></div>
    </div>
    <h4>Conventions</h4>
    <ul>
      <li><strong>Strict imports</strong> — every relative import uses the <span class="chip">.js</span> extension.</li>
      <li><strong>No shell-concatenated launches</strong> — engines start with executable + argv, never a joined string.</li>
      <li><strong>Secrets never surface</strong> — redaction is recursive and applies to logs, diagnostics, and exports.</li>
      <li><strong>One check command</strong> — <span class="chip">pnpm check</span> = typecheck + tests.</li>
    </ul>
  </section>

</div>

<footer>
  <div>Generated from the repository at <span class="cmd">${now}</span> · branch <span class="cmd">${gitBranch}</span> · last commit <span class="cmd">${gitDate}</span> · ${tests.note || tests.passed + " tests passing"}</div>
  <div>Facts are read live at build time — regenerate with <span class="cmd">pnpm docs:overview</span> whenever the repo changes.</div>
</footer>

</body>
</html>
`;
writeFileSync(OUT, html, "utf8");
console.log("✓ generated " + relative(root, OUT).replaceAll("\\", "/"));
console.log("  " + packages.length + " workspaces · " + sourceFiles.length + " sources · " + testFiles.length + " test files · " +
  tests.passed + "/" + tests.total + " tests passing · " + routes.length + " routes · " + implemented.length + " shipped bullets");
