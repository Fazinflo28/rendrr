// Writes src/motionTemplate/runtimeCode.ts from src/motionTemplate/runtime.js (the motion template player, plain
// browser JavaScript), so the graphic HTML can carry it as a string. Run after changing runtime.js:
//   node packages/shared/scripts/gen-motion-runtime.mjs
// A test fails when the two differ.
import fs from "node:fs";
const dir = new URL("../src/motionTemplate/", import.meta.url);
const code = fs.readFileSync(new URL("runtime.js", dir), "utf8");
fs.writeFileSync(new URL("runtimeCode.ts", dir), `// Generated from runtime.js by scripts/gen-motion-runtime.mjs. Do not edit by hand.\nexport const MOTION_RUNTIME = ${JSON.stringify(code)};\n`);
console.log("runtimeCode.ts written", code.length);
