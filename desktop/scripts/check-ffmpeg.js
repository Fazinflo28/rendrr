// The build's check of the FFmpeg the app ships (node scripts/check-ffmpeg.js <path>): it runs, and has what Rendrr's
// renders use. Without the core ones the build stops; without a rarer one (HDR, stabilizing, HEVC) it says so, and
// Rendrr makes those renders on its cloud server instead (the app reports what it has).
"use strict";
const { probeFfmpeg, FEATURES } = require("../render");
const CORE = ["libx264", "ass", "lut3d", "libvpx-vp9", "sendcmd", "alphamerge", "palettegen", "paletteuse"];
(async () => {
  const p = await probeFfmpeg(process.argv[2]);
  if (!p.ok) { console.error(`FFmpeg does not run: ${p.why}`); process.exit(1); }
  console.log(`FFmpeg ${p.version}: has ${p.have.join(", ")}`);
  const missing = FEATURES.filter((f) => !p.have.includes(f));
  if (missing.length) console.log(`Missing (those renders go to Rendrr's cloud): ${missing.join(", ")}`);
  const core = CORE.filter((f) => !p.have.includes(f));
  if (core.length) { console.error(`Missing what most renders need: ${core.join(", ")}`); process.exit(1); }
})();
