// Rendering on the user's Mac (core/macRender.ts). The Rendrr web app, open in the Mac app, lists the user's renders
// waiting for a Mac and takes one (signed in as the user); the Mac app's own process then downloads, renders and
// uploads, reporting here with the task's token (handed only to the Mac that took it). Done or failed, the worker
// waiting on the task carries on: it checks the file, or makes the render on Rendrr's cloud server instead.
import { claimMacTask, env, failMacTask, finishMacTask, listMacTasks, macManifest, reportMacTask, type MacReport } from "@rendrr/core";
import { deviceName } from "@rendrr/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth";

const ID = /^[0-9a-f-]{36}$/;
const tokenOf = (req: FastifyRequest) => String(req.headers["x-rendrr-task-token"] || "");
const gone = (reply: FastifyReply) => reply.code(404).send({ error: { message: "That render is not yours to report on, or it is over.", code: "not-found" } });
const idOf = (req: FastifyRequest) => { const id = String((req.params as { id?: string }).id || ""); return ID.test(id) ? id : null; };

export default async function macRender(app: FastifyInstance) {
  // ---- The Mac app's process, with the task's token ----
  app.post("/desktop/tasks/:id/progress", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply) => {
    const id = idOf(req);
    const b = (req.body ?? {}) as MacReport;
    const r = id ? await reportMacTask(id, tokenOf(req), { phase: b.phase, frac: Number(b.frac), cmd: Number(b.cmd), seconds: Number(b.seconds) }) : null;
    return r ?? gone(reply);
  });
  app.post("/desktop/tasks/:id/done", async (req, reply) => {
    const id = idOf(req);
    const b = (req.body ?? {}) as { outputs?: Record<string, number>; saved?: string | null };
    const ok = id ? await finishMacTask(id, tokenOf(req), b.outputs && typeof b.outputs === "object" ? b.outputs : {}, typeof b.saved === "string" ? b.saved : null) : false;
    return ok ? { ok: true } : gone(reply);
  });
  app.post("/desktop/tasks/:id/failed", async (req, reply) => {
    const id = idOf(req);
    const b = (req.body ?? {}) as { error?: string };
    const ok = id ? await failMacTask(id, tokenOf(req), String(b.error || "")) : false;
    return ok ? { ok: true } : gone(reply);
  });

  // ---- The web app in the Mac app, signed in ----
  await app.register(async (a) => {
    a.addHook("preHandler", authenticate);
    a.get("/desktop/tasks", async (req) => ({ tasks: await listMacTasks(req.user!.id) }));
    a.post("/desktop/tasks/:id/claim", async (req) => {
      const id = idOf(req);
      const got = id ? await claimMacTask(req.user!.id, id, deviceName(String((req.body as { device?: unknown } | null)?.device ?? ""))) : null;
      return { task: got ? await macManifest(got.task, got.token, env().PUBLIC_API_URL) : null };
    });
  });
}
