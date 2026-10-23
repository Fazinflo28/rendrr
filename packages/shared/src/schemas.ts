import { z } from "zod";
import { ASPECTS, PROJECT_STATUSES } from "./constants";
import { TimelineSchema } from "./timeline";

// Input checks shared by the API server and the MCP server. Messages are plain English.
const name = (what: string) => z.string({ required_error: `Give the ${what} a name.` }).trim().min(1, `Give the ${what} a name.`).max(200, `That ${what} name is too long.`);
const id = z.string().min(1).max(80);

export const CreateFolderInput = z.object({ name: name("project") });
export const RenameFolderInput = z.object({ name: name("project") });

export const CreateProjectInput = z.object({
  videoId: z.string({ required_error: "Pick footage first." }).min(1, "Pick footage first.").max(80),
  styleId: id.optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  folderId: id.optional().nullable(),
  cut: z.array(z.string().max(40)).max(50_000).optional(),
  aspect: z.enum(ASPECTS).optional(),
});

export const UpdateProjectInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  styleId: id.optional(),
  aspect: z.enum(ASPECTS).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  timeline: TimelineSchema.optional(),
  baseVersion: z.number().int().min(0).optional(),
});

const kind = z.enum(["footage", "reference"]).optional(); // reference: a video whose style to copy
export const DriveAddInput = z.object({ fileIds: z.array(z.string().min(1).max(200)).min(1, "Pick at least one video.").max(50), kind });
export const ReconnectInput = z.object({ fileId: z.string().min(1, "Pick the file in Drive to reconnect it.").max(200) });

export const LocalFilesInput = z.object({
  files: z.array(z.object({ name: z.string().min(1).max(300), size: z.number().int().min(1).max(200e9), type: z.string().max(100).optional() })).min(1).max(20),
  kind,
});
export const SampleAddInput = z.object({ kind }).default({});
export const VideoPatchInput = z.object({ kind: z.enum(["footage", "reference"]).optional(), name: z.string().trim().min(1, "Give the video a name.").max(200).optional() });
export const LocalProgressInput = z.object({ status: z.enum(["previewing", "uploading", "paused", "failed"]), progress: z.number().min(0).max(100).optional(), error: z.string().max(300).optional() });
export const LocalCompleteInput = z.object({
  seconds: z.number().min(0.1).max(24 * 3600),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(240).optional(),
  proxySize: z.number().int().min(1),
  audioSize: z.number().int().min(1),
});

export const OriginalUploadInput = z.object({ name: z.string().min(1).max(300), size: z.number().int().min(1).max(200e9) });
export const OriginalCompleteInput = z.object({ uploadId: z.string().min(1).max(400), parts: z.array(z.object({ PartNumber: z.number().int().min(1).max(10000), ETag: z.string().min(1).max(200) })).min(1).max(10000) });

export const CreateReviewInput = z.object({
  projectId: id.optional().nullable(),
  folderId: id.optional().nullable(),
  version: z.coerce.number().int().min(1).max(10_000).optional(),
  password: z.string().max(100).optional().nullable(),
  expires: z.string().max(40).optional().nullable(),
  expiresDays: z.number().int().min(1).max(365).optional(),
  allowDownload: z.boolean().optional(),
  showLogo: z.boolean().optional(),
});
export const ReviewCommentInput = z.object({ time: z.number().min(0).max(24 * 3600), text: z.string().trim().min(1, "Write a comment first.").max(2000, "That comment is too long.") });
export const ProjectCommentInput = ReviewCommentInput;
export const AiChatInput = z.object({ text: z.string().trim().min(1, "Write what you want changed first.").max(4000, "That message is too long. Keep it under 4000 characters.") });
export const PlanInput = z.object({ plan: z.enum(["Free", "Pro", "Studio"], { errorMap: () => ({ message: "Pick Free, Pro or Studio." }) }) });
export const ReviewPasswordInput = z.object({ password: z.string().max(100) });
export const RequestChangesInput = z.object({ note: z.string().max(4000).optional().nullable() });
export const ResolveCommentInput = z.object({ resolved: z.boolean().default(true) });

export const PublishInput = z.object({
  projectId: z.string({ required_error: "Pick a project to publish." }).min(1, "Pick a project to publish.").max(80),
  title: z.string().max(200).optional().nullable(),
  platforms: z.array(z.enum(["instagram", "tiktok", "youtube", "linkedin"])).max(4).optional(),
  allowRecreate: z.boolean().optional(),
});

export const ProfilePatch = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120).optional(),
  email: z.string().trim().email("That email does not look right.").max(200).optional(),
  photo: z.string().max(4_000_000, "That photo is too big. Pick one under 3 MB.").nullable().optional(),
});
export const LogoInput = z.object({ dataUrl: z.string().max(4_000_000, "That logo is too big. Pick one under 3 MB.").nullable() });
export const SettingsPatch = z.object({ autoDelete: z.boolean().optional(), theme: z.enum(["system", "light", "dark"]).optional() });

export const CreateGraphicInput = z.object({
  name: z.string().max(120).optional(),
  code: z.string().min(1).max(200_000, "That graphic code is too long (200 KB max)."),
  durationSec: z.number().min(0.5).max(15, "Graphics can be 15 seconds long at most."),
  width: z.number().int().min(64).max(1920),
  height: z.number().int().min(64).max(1920),
  transparent: z.boolean().default(true),
}).refine((g) => Math.min(g.width, g.height) <= 1080, "Graphics can be 1080x1920 at most.");

export const LoginInput = z.object({ email: z.string().trim().min(1, "Enter your email to continue.").max(200), password: z.string().min(1, "Enter your password.").max(200) });
export const SignupInput = z.object({ name: z.string().max(120).optional().nullable(), email: z.string().trim().min(1, "Enter your email to continue.").email("That email does not look right.").max(200), password: z.string().min(8, "Use at least 8 characters for your password.").max(200) });
