import { isSupabaseLogin, supabaseAdmin, supabaseIsLogin, supabaseLoginId } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { forgetUser } from "../auth";

/**
 * The switch to Supabase Auth: every Rendrr account that has no Supabase login yet gets one, with the account's email
 * (confirmed, no password). Then "Forgot password" and "Log in with Google" both work for people who signed up
 * through Clerk, and land in their own account. An email Supabase already has is left alone: that login opens the
 * account by its verified email the first time it is used. Runs at start-up once Supabase is the login; safe to run
 * again (an account with a Supabase login is skipped).
 */
export async function importUsersToSupabase(): Promise<{ created: number; existed: number; failed: number }> {
  const out = { created: 0, existed: 0, failed: 0 };
  const a = supabaseAdmin();
  if (!a || !supabaseIsLogin()) return out;
  const users = await prisma.user.findMany({ where: { email: { not: "" }, NOT: { clerkId: { startsWith: "system:" } } }, select: { id: true, clerkId: true, email: true, name: true, logins: { select: { clerkId: true } } }, take: 5000 });
  for (const u of users) {
    if (isSupabaseLogin(u.clerkId) || u.logins.some((l) => isSupabaseLogin(l.clerkId))) continue;
    const { data, error } = await a.auth.admin.createUser({ email: u.email.trim().toLowerCase(), email_confirm: true, user_metadata: { full_name: u.name, imported_from: "clerk" } });
    if (error || !data?.user) {
      if (/already|registered|exists/i.test(error?.message || "")) out.existed++; else out.failed++;
      continue;
    }
    const loginId = supabaseLoginId(data.user.id);
    await prisma.userLogin.upsert({ where: { clerkId: loginId }, create: { clerkId: loginId, userId: u.id }, update: { userId: u.id } });
    forgetUser(loginId);
    out.created++;
  }
  return out;
}
