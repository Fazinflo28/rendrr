// Builds the API for Vercel with the Build Output API (https://vercel.com/docs/build-output-api):
// one Node.js function that answers every path. Run from apps/api after `prisma generate`.
// The workspace packages are bundled into one file; Prisma's client (with its query engine) is copied next to it.
import { build } from "esbuild";
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const out = ".vercel/output";
const fn = join(out, "functions/index.func");
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: ["src/vercel.ts"],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@prisma/client", ".prisma/client"],
  // Some bundled packages still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

// @prisma/client and the generated .prisma/client live side by side in pnpm's store.
const require = createRequire(realpathSync("../../packages/db/package.json"));
const prismaPkg = dirname(require.resolve("@prisma/client/package.json"));
const generated = join(dirname(prismaPkg), "..", ".prisma", "client");
cpSync(realpathSync(prismaPkg), join(fn, "node_modules/@prisma/client"), { recursive: true, dereference: true });
cpSync(realpathSync(generated), join(fn, "node_modules/.prisma/client"), { recursive: true, dereference: true });

// Data files the API reads at run time (the icon set).
cpSync("src/data", join(fn, "data"), { recursive: true });
writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({
  runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 300,
}, null, 2));
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }, null, 2));
console.log("vercel output ready:", fn);
