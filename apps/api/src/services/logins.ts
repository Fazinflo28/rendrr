// Several logins, one Rendrr account. Someone whose AI connector signed in with a different Google account than the
// website gets a link code on the website (Connect AI) and gives it to their AI, which calls link_account with it.
import { AppError, redis } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { randomInt } from "node:crypto";
import { clerk, forgetUser } from "../auth";

const CODE_SECONDS = 15 * 60;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const codeKey = (code: string) => `link-code:${code}`;

export async function createLinkCode(userId: string) {
  const code = Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
  await redis().set(codeKey(code), userId, "EX", CODE_SECONDS);
  return { code, expiresInMinutes: CODE_SECONDS / 60 };
}

/** Anything a person made in an account. An account with any of it is never removed by linking. */
export async function hasOwnData(userId: string) {
  const counts = await Promise.all([
    prisma.video.count({ where: { userId } }),
    prisma.project.count({ where: { userId } }),
    prisma.style.count({ where: { ownerId: userId } }),
    prisma.graphic.count({ where: { ownerId: userId } }),
    prisma.reference.count({ where: { userId } }),
    prisma.review.count({ where: { userId } }),
    prisma.galleryItem.count({ where: { userId } }),
    prisma.driveConnection.count({ where: { userId, stub: false } }),
  ]);
  return counts.some((n) => n > 0);
}

/**
 * Links the login `clerkId` to the account that made `code`. When that login had its own account and it is empty
 * (made on first sight, nothing added since), that empty account is removed; one with anything in it is kept and
 * the link is refused.
 */
export async function redeemLinkCode(clerkId: string, code: string): Promise<{ userId: string; already: boolean; removedEmpty: boolean }> {
  const target = await redis().getdel(codeKey(code.trim().toUpperCase()));
  if (!target) throw new AppError("That link code is wrong or has expired. Ask the user for a new one: Rendrr > Connect AI > Link another login.", 400, "bad-code");
  if (!(await prisma.user.findUnique({ where: { id: target }, select: { id: true } }))) throw new AppError("The account that made this code no longer exists.", 400, "bad-code");
  const own = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  const alias = own ? null : await prisma.userLogin.findUnique({ where: { clerkId } });
  if ((own?.id ?? alias?.userId) === target) return { userId: target, already: true, removedEmpty: false };
  let removedEmpty = false;
  if (own) {
    if (await hasOwnData(own.id)) throw new AppError("This login already has its own videos or edits in Rendrr, so it was not linked (that would hide them). Use the login that holds them, or move them first.", 409, "has-data");
    // Logins linked to the empty account follow it to the target account.
    await prisma.$transaction([
      prisma.userLogin.updateMany({ where: { userId: own.id }, data: { userId: target } }),
      prisma.user.delete({ where: { id: own.id } }),
      prisma.userLogin.create({ data: { clerkId, userId: target } }),
    ]);
    removedEmpty = true;
  } else {
    await prisma.userLogin.upsert({ where: { clerkId }, create: { clerkId, userId: target }, update: { userId: target } });
  }
  forgetUser(clerkId);
  return { userId: target, already: false, removedEmpty };
}

/** The logins that open this account: its main one and any linked, with their email. */
export async function listLogins(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { clerkId: true, email: true } });
  const extra = await prisma.userLogin.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const emailOf = async (id: string) => {
    try { const cu = await clerk().users.getUser(id); return cu.primaryEmailAddress?.emailAddress || cu.emailAddresses[0]?.emailAddress || ""; } catch { return ""; }
  };
  return [
    { id: u.clerkId, email: (await emailOf(u.clerkId)) || u.email, main: true, at: null as number | null },
    ...(await Promise.all(extra.map(async (l) => ({ id: l.clerkId, email: await emailOf(l.clerkId), main: false, at: l.createdAt.getTime() })))),
  ];
}

export async function unlinkLogin(userId: string, clerkId: string) {
  const l = await prisma.userLogin.findUnique({ where: { clerkId } });
  if (!l || l.userId !== userId) throw new AppError("That login is not linked to this account.", 404);
  await prisma.userLogin.delete({ where: { clerkId } });
  forgetUser(clerkId);
}
