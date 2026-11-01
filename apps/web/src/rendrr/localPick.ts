// Which picked files are sent as new videos. No browser APIs here (unit-tested on its own).
type Picked = { name: string; type?: string; rendrrFolder?: string; webkitRelativePath?: string };
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|3gp|wmv|mpg|mpeg)$/i;
/** A video file (by type, or by name when the browser gives no type). */
export const isVideoFile = (f: Picked) => (f.type ? f.type.startsWith("video/") : VIDEO_EXT.test(f.name)) && !f.name.startsWith(".");
/** The folders a file sat in inside the folder picked or dropped, the picked folder first ("Course/Module 1"); "" for a
 *  file picked on its own. */
export const folderOfFile = (f: Picked) => {
  if (f.rendrrFolder !== undefined) return f.rendrrFolder;
  const rel = f.webkitRelativePath;
  return rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
};
/** The files to add: from a folder, only its videos (a folder holds other files too); picked one by one, all of them
 *  (the server says if one cannot be read). A new list: the picked one is left as it was. */
export function filesToAdd<T extends Picked>(picked: T[]): { files: T[]; fromFolder: boolean } {
  const fromFolder = picked.some((f) => folderOfFile(f));
  return { files: fromFolder ? picked.filter(isVideoFile) : [...picked], fromFolder };
}
