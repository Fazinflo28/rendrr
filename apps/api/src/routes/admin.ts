// The admin panel's API (Rendrr's team only: role admin or ADMIN_EMAILS) and the web app's error reports.
import { AppError } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { adminChange, assertAdmin, auditLog, billingReport, clientFolders, connections, costs, galleryList, issues, listUsers, overview, recentJobs, recordClientError, renderHealth, storageReport, systemHealth, userDetail } from "../services/admin";

export default async function admin(app: FastifyInstance) {
  // A browser error: no login needed (it may be the login page that broke), a few a minute per IP.
  app.post("/telemetry/client-error", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ message: z.string().min(1).max(2000), stack: z.string().max(8000).optional().nullable(), url: z.string().max(1000).optional().nullable(), userId: z.string().max(60).optional().nullable() }).parse(req.body);
    const userId = b.userId && (await prisma.user.count({ where: { id: b.userId } })) ? b.userId : null;
    await recordClientError({ ...b, userAgent: String(req.headers["user-agent"] || ""), userId });
    return { ok: true };
  });

  app.register(async (a) => {
    a.addHook("preHandler", authenticate);
    a.addHook("preHandler", async (req) => { await assertAdmin(req.user!.id); });
    a.get("/admin/me", async () => ({ admin: true }));
    a.get("/admin/overview", async () => overview());
    a.get("/admin/users", async (req) => {
      const q = z.object({ q: z.string().max(120).optional(), sort: z.string().max(20).optional(), plan: z.string().max(20).optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
      return listUsers(q);
    });
    a.get("/admin/users/:id", async (req) => userDetail((req.params as { id: string }).id));
    a.post("/admin/users/:id", async (req) => {
      const change = z.object({
        plan: z.enum(["trial", "comp"]).optional(), trialDays: z.number().int().min(-30).max(365).optional(),
        bonusExportMinutes: z.number().min(-10_000).max(10_000).optional(), bonusFootageMinutes: z.number().min(-10_000).max(10_000).optional(),
        spendLimitCents: z.number().int().min(0).max(1_000_000).optional(), role: z.enum(["user", "admin"]).optional(),
        reason: z.string().max(300).optional(),
      }).strict().parse(req.body);
      return adminChange(req.user!.id, (req.params as { id: string }).id, change);
    });
    a.get("/admin/costs", async (req) => costs(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query).days ?? 30));
    a.get("/admin/storage", async () => storageReport());
    a.get("/admin/issues", async (req) => issues(z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query).days ?? 7));
    a.post("/admin/issues/client/:id/resolve", async (req) => {
      const r = await prisma.clientError.updateMany({ where: { id: (req.params as { id: string }).id }, data: { resolved: true } });
      if (!r.count) throw new AppError("That error is gone.", 404);
      return { ok: true };
    });
    // The sections modelled on Dragly's admin panel.
    const page = { q: z.string().max(120).optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() };
    a.get("/admin/folders", async (req) => clientFolders(z.object(page).parse(req.query)));
    a.get("/admin/billing", async (req) => billingReport(z.object({ ...page, status: z.string().max(20).optional() }).parse(req.query)));
    a.get("/admin/renders", async (req) => renderHealth(z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query).days ?? 7));
    a.get("/admin/audit", async (req) => auditLog(z.object({ ...page, action: z.string().max(60).optional(), days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query)));
    a.get("/admin/connections", async () => connections());
    a.get("/admin/health", async () => systemHealth());
    a.get("/admin/gallery", async () => galleryList());
    a.get("/admin/jobs", async (req) => recentJobs(z.object({ queue: z.string().max(40).optional(), event: z.string().max(10).optional(), userId: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(300).optional() }).parse(req.query)));
  });
}
