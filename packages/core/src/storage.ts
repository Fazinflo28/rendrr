import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command,
  PutBucketCorsCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "./env";

// One private bucket. Every read and write is a short-lived signed URL or a server-side call.
// Raw keys never leave the server.
let client: S3Client | null = null;
export function s3(): S3Client {
  if (client) return client;
  const e = env();
  client = new S3Client({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION || "auto", // R2 and Railway Buckets expect "auto"; AWS and MinIO take a real region
    forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // A stalled connection fails (and is retried by the SDK) instead of hanging a job: 10 s to connect,
    // 2 minutes without any data.
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    // The bucket answers "Please reduce your request rate" (SlowDown) when many files go up at once (a graphic's
    // variants, a render's frames): retried more times, and the client slows itself down while it is told to.
    maxAttempts: 5,
    retryMode: "adaptive",
  });
  return client;
}
const Bucket = () => env().S3_BUCKET;

/**
 * A link to a stored file, good for at least `seconds`. Links are signed at the start of a time slot (a quarter of
 * their life, from a minute to an hour) and last that much longer, so asking again within the slot gives the same
 * link: a page that refreshes a list every few seconds (the Library, with 500 thumbnails) keeps the pictures the
 * browser already has, where a new link each time made it fetch them all again.
 */
export async function signGet(key: string, seconds = 3600, opts: { download?: string; contentType?: string; now?: number } = {}): Promise<string> {
  const slot = signSlot(seconds), nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: Bucket(), Key: key,
    ...(opts.download ? { ResponseContentDisposition: `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, "_")}"` } : {}),
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  }), { expiresIn: Math.min(604_800, seconds + slot), signingDate: new Date((nowS - (nowS % slot)) * 1000) });
}
/** The time slot links of this life are signed in (seconds): a quarter of it, from a minute to an hour. */
export const signSlot = (seconds: number) => Math.min(3600, Math.max(60, Math.floor(seconds / 4)));
export async function signPut(key: string, contentType: string, seconds = 3600): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: Bucket(), Key: key, ContentType: contentType }), { expiresIn: seconds });
}
export async function putObject(key: string, body: Buffer | string | Readable, contentType: string, contentLength?: number) {
  await s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: body, ContentType: contentType, ...(contentLength != null ? { ContentLength: contentLength } : {}) }));
}
/** The bucket asked us to slow down (SlowDown, 503, 429): worth sending again after a pause. */
export const throttled = (e: unknown) => {
  const x = e as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  return /SlowDown|reduce your request rate|TooManyRequests|ServiceUnavailable|Throttl/i.test(`${x?.name} ${x?.code} ${x?.message}`) || [429, 503].includes(x?.$metadata?.httpStatusCode ?? 0);
};

export async function uploadFile(key: string, path: string, contentType: string): Promise<number> {
  const { size } = await stat(path);
  if (size > 4.5e9) throw new Error("file too large for single upload");
  // The SDK cannot send a stream twice, so its own retries do not cover a file: a dropped connection (a kept-alive
  // socket the server had already closed after a pause), the bucket asking us to slow down, a 5xx, or the bucket's
  // gateway failing part way ("Request body is not seekable, cannot retry": it could not send our stream on again) is
  // sent again from the file here, after a pause that grows (1, 2, 4, 8 s, with some spread so files sent together do
  // not come back together).
  for (let attempt = 0; ; attempt++) {
    try { await putObject(key, createReadStream(path), contentType, size); return size; }
    catch (e) {
      const why = `${(e as Error).message} ${(e as { code?: string }).code ?? ""}`;
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
      const again = /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|non-retryable streaming|not seekable|cannot retry/i.test(why) || throttled(e) || status >= 500;
      if (attempt >= 4 || !again) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5)));
    }
  }
}
export async function downloadFile(key: string, path: string): Promise<number> {
  const r = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
  await pipeline(r.Body as Readable, createWriteStream(path));
  return (await stat(path)).size;
}
export async function getText(key: string): Promise<string> {
  const r = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
  return await (r.Body as { transformToString(): Promise<string> }).transformToString();
}
export async function getBytes(key: string): Promise<Buffer> {
  const r = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
  return Buffer.from(await (r.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
}
export async function headObject(key: string): Promise<{ size: number; contentType?: string; etag?: string } | null> {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key }));
    return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType, etag: r.ETag?.replace(/"/g, "") };
  } catch (e) {
    const code = (e as { name?: string; $metadata?: { httpStatusCode?: number } });
    if (code.name === "NotFound" || code.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
export async function deleteObject(key: string | null | undefined) {
  if (!key) return;
  await s3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: key }));
}
export async function deleteObjects(keys: (string | null | undefined)[]) {
  const ks = keys.filter((k): k is string => !!k);
  for (let i = 0; i < ks.length; i += 900) {
    const chunk = ks.slice(i, i + 900);
    await s3().send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
  }
}
export async function deletePrefix(prefix: string) {
  let token: string | undefined;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: prefix, ContinuationToken: token }));
    await deleteObjects((r.Contents || []).map((o) => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}
export async function listPrefix(prefix: string, max = 1000): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const out: { key: string; size: number; lastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, max - out.length) }));
    for (const o of r.Contents || []) out.push({ key: o.Key!, size: Number(o.Size ?? 0), lastModified: o.LastModified ?? new Date(0) });
    token = r.IsTruncated && out.length < max ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
export async function copyObject(from: string, to: string) {
  await s3().send(new CopyObjectCommand({ Bucket: Bucket(), CopySource: `${Bucket()}/${encodeURIComponent(from).replace(/%2F/g, "/")}`, Key: to }));
}

// Multipart upload straight from the browser (originals for export).
export async function createMultipart(key: string, contentType: string): Promise<string> {
  const r = await s3().send(new CreateMultipartUploadCommand({ Bucket: Bucket(), Key: key, ContentType: contentType }));
  return r.UploadId!;
}
export async function signPart(key: string, uploadId: string, partNumber: number, seconds = 6 * 3600): Promise<string> {
  return getSignedUrl(s3(), new UploadPartCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: seconds });
}
export async function completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]) {
  await s3().send(new CompleteMultipartUploadCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) } }));
}
export async function abortMultipart(key: string, uploadId: string) {
  try { await s3().send(new AbortMultipartUploadCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId })); } catch { /* already gone */ }
}
/** Aborts unfinished browser uploads under a prefix that started before `before` (their parts cost storage). */
export async function abortStaleMultipart(prefix: string, before: Date): Promise<number> {
  let n = 0;
  let keyMarker: string | undefined, idMarker: string | undefined;
  do {
    const r = await s3().send(new ListMultipartUploadsCommand({ Bucket: Bucket(), Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: idMarker }));
    for (const u of r.Uploads || []) {
      if (u.Key && u.UploadId && u.Initiated && u.Initiated < before) { await abortMultipart(u.Key, u.UploadId); n++; }
    }
    keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    idMarker = r.IsTruncated ? r.NextUploadIdMarker : undefined;
  } while (keyMarker);
  return n;
}

export function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  return ({ mp4: "video/mp4", m4a: "audio/mp4", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", json: "application/json", mov: "video/quicktime", wav: "audio/wav", gif: "image/gif", srt: "text/plain", vtt: "text/vtt", txt: "text/plain" } as Record<string, string>)[ext || ""] || "application/octet-stream";
}

/** Browsers upload previews and originals straight to storage, so the bucket must allow the web app's origin. */
export async function ensureBucketCors(origins: string[]) {
  await s3().send(new PutBucketCorsCommand({ Bucket: Bucket(), CORSConfiguration: { CORSRules: [{
    AllowedOrigins: origins, AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag", "Content-Length", "Content-Range"], MaxAgeSeconds: 3600,
  }] } }));
}

/** Every stored file of a render: the video, its frames and its side files (captions .srt/.vtt, chapters), so a
 *  delete takes them all. The side files sit on the render's plan as { files: { name: key } }. */
export function renderFileKeys(r: { outputKey?: string | null; framesKeys?: unknown; plan?: unknown }): string[] {
  const side = (r.plan as { files?: Record<string, unknown> } | null)?.files;
  return [r.outputKey, ...(((r.framesKeys as string[]) || [])), ...(side ? Object.values(side) : [])].filter((k): k is string => typeof k === "string" && !!k);
}
/** The plan without its side files, for a render whose files were deleted. */
export function planWithoutFiles(plan: unknown): Record<string, unknown> | null {
  if (!plan || typeof plan !== "object") return null;
  const { files: _files, ...rest } = plan as Record<string, unknown>;
  return rest;
}
