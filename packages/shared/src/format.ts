// Display helpers that match how the UI's fake data looked ("2.4 GB", "180 MB", "Nov 14").
export function fmtSize(bytes: number | bigint | null | undefined): string {
  const b = Number(bytes || 0);
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  return Math.round(b / 1e6) + " MB";
}
export function fmtShortDate(d: Date | number): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
export function orientationOf(width: number, height: number): "Landscape" | "Portrait" | "Square" {
  if (!width || !height) return "Landscape";
  const r = width / height;
  if (r > 1.1) return "Landscape";
  if (r < 0.9) return "Portrait";
  return "Square";
}
export function aspectFor(orientation: string): "16:9" | "9:16" | "1:1" { // a new edit takes the footage's own shape
  return orientation === "Portrait" ? "9:16" : orientation === "Square" ? "1:1" : "16:9";
}
