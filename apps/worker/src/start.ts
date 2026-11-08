// The worker's entry. In maintenance mode (MAINTENANCE=1, while the database moves) it only answers Railway's health
// check: no jobs, no database. Jobs wait in Redis and run when the worker is back. Otherwise the whole worker starts.
import { maintenanceOn } from "@rendrr/core";
import { createServer } from "node:http";

if (maintenanceOn()) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "rendrr-worker", maintenance: true })); });
  server.listen(port, () => console.log(`[worker] maintenance mode: health on :${port}, no jobs taken, nothing touches the database`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} else {
  const { dbHost } = await import("@rendrr/db");
  console.log(`[worker] database ${dbHost(process.env.DATABASE_URL)}`);
  await import("./index");
}
