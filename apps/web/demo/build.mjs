// Builds the UI preview: the real app screens with the design's in-browser fake backend, as one HTML file
// (no server, no login service). Usage: node demo/build.mjs [out.html]   (run from apps/web)
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const out = resolve(process.argv[2] || resolve(web, "demo/dist/rendrr-preview.html"));
mkdirSync(dirname(out), { recursive: true });

// The fake backend is the first inline <script> of the V2 design file.
const design = readFileSync(resolve(web, "../../ui/rendrr-ui-v2.html"), "utf8");
const block = [...design.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("FAKE BACKEND"));
if (!block) throw new Error("Fake backend not found in ui/rendrr-ui-v2.html");
const hooked = block.replace("if (file) localFiles[v.id] = file;", "if (file) { localFiles[v.id] = file; globalThis.__rendrrDemoFile?.(v, file); }");

const res = await build({
  entryPoints: [resolve(here, "entry.js")],
  bundle: true, format: "iife", platform: "browser", target: "es2020", minify: true, write: false,
  define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' },
  plugins: [{
    name: "demo",
    setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: resolve(here, "navigation.js") }));
      b.onResolve({ filter: /^\.\/api$/ }, (a) => (a.importer.includes("/src/rendrr/") ? { path: resolve(here, "api.js") } : undefined));
      b.onResolve({ filter: /^rendrr-fake-api$/ }, () => ({ path: "fake-api", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: hooked + "\nexport { api };", loader: "js" }));
    },
  }],
  logLevel: "warning",
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync(resolve(web, "src/rendrr/styles.css"), "utf8");

const html = `<meta charset="utf-8">
<title>Rendrr</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
${css}
#app { height: 100%; }
#demo-note { position: fixed; left: max(12px, env(safe-area-inset-left, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px)); transition: opacity .4s; max-width: calc(100vw - 24px); z-index: 30; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 999px; background: var(--raised); color: var(--muted); font: 12px/16px var(--font); box-shadow: var(--shadow-pop); }
#demo-note b { color: var(--ink); font-weight: 500; }
#demo-note button { width: 22px; height: 22px; border-radius: 50%; color: var(--muted); }
#demo-note button:hover { background: var(--hair-strong); color: var(--ink); }
@media (max-width: 1023px) { #demo-note { bottom: calc(72px + env(safe-area-inset-bottom, 0px)); } }
</style>
<div id="app"></div>
<div id="demo-note" role="note"><span><b>Preview</b> with demo data. Nothing is sent anywhere.</span><button type="button" aria-label="Hide this note">✕</button></div>
<script>${js}</script>
`;
writeFileSync(out, html);
console.log(`preview: ${out} (${(html.length / 1024).toFixed(0)} KB)`);
