// Errors people see. `message` is always plain English; never a stack trace.
export class AppError extends Error {
  friendly = true;
  constructor(message: string, public status = 400, public code?: string, public meta?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (msg: string) => new AppError(msg, 404, "not-found");
export const forbidden = (msg = "You do not have access to that.") => new AppError(msg, 403, "forbidden");
export const unauthorized = (msg = "Please log in again.") => new AppError(msg, 401, "unauthorized");

/** Turns anything thrown into something safe to show. Unknown errors become a generic sentence. */
export function toFriendly(e: unknown, fallback = "Something went wrong on our side. Please try again."): { message: string; status: number; code?: string; meta?: Record<string, unknown> } {
  const err = e as { friendly?: boolean; message?: string; status?: number; code?: string; meta?: Record<string, unknown>; issues?: { message: string }[] };
  if (err && err.friendly && err.message) return { message: err.message, status: err.status ?? 400, code: err.code, meta: err.meta };
  if (err && Array.isArray(err.issues) && err.issues.length) return { message: err.issues[0].message, status: 400, code: "invalid" };
  return { message: fallback, status: 500, code: "internal" };
}
