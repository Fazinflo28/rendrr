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
  });
  return client;
}
const Bucket = () => env().S3_BUCKET;

export async function signGet(key: string, seconds = 3600, opts: { download?: string; contentType?: string } = {}): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: Bucket(), Key: key,
    ...(opts.download ? { ResponseContentDisposition: `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, "_")}"` } : {}),
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  }), { expiresIn: seconds });
}
export async function signPut(key: string, contentType: string, seconds = 3600): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: Bucket(), Key: key, ContentType: contentType }), { expiresIn: seconds });
}
export async function putObject(key: string, body: Buffer | string | Readable, contentType: string, contentLength?: number) {
  await s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: body, ContentType: contentType, ...(contentLength != null ? { ContentLength: contentLength } : {}) }));
}
export async function uploadFile(key: string, path: string, contentType: string): Promise<number> {
  const { size } = await stat(path);
  if (size > 4.5e9) throw new Error("file too large for single upload");
  await putObject(key, createReadStream(path), contentType, size);
  return size;
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
export async function headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key }));
    return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
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
  return ({ mp4: "video/mp4", m4a: "audio/mp4", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", json: "application/json", mov: "video/quicktime", wav: "audio/wav" } as Record<string, string>)[ext || ""] || "application/octet-stream";
}

/** Browsers upload previews and originals straight to storage, so the bucket must allow the web app's origin. */
export async function ensureBucketCors(origins: string[]) {
  await s3().send(new PutBucketCorsCommand({ Bucket: Bucket(), CORSConfiguration: { CORSRules: [{
    AllowedOrigins: origins, AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag", "Content-Length", "Content-Range"], MaxAgeSeconds: 3600,
  }] } }));
}
