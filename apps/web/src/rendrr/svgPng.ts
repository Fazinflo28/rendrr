import { fail } from "./http";

/** An SVG drawn to a PNG (the longer side 2048 px at most, transparent), for an element. */
export async function svgToPng(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(fail("That SVG could not be drawn. Save it as a PNG and try again.")); i.src = url; });
    const w0 = img.naturalWidth || 1024, h0 = img.naturalHeight || 1024, k = Math.min(4, 2048 / Math.max(w0, h0));
    const c = document.createElement("canvas"); c.width = Math.max(2, Math.round(w0 * k)); c.height = Math.max(2, Math.round(h0 * k));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(fail("That SVG could not be drawn."))), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}

/** The file as it goes up: an element given as an SVG is drawn to a PNG first (the server keeps pictures, not SVG). */
export async function assetFile(file: File, as: string): Promise<{ body: Blob; name: string; type: string }> {
  const name = file.name || "Upload";
  if (as === "element" && (file.type === "image/svg+xml" || /\.svg$/i.test(name))) return { body: await svgToPng(file), name: name.replace(/\.svg$/i, "") + ".png", type: "image/png" };
  return { body: file, name, type: file.type };
}
