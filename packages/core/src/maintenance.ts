// Maintenance mode (MAINTENANCE=1 on api2 and the worker): used while the database moves. The API answers every request
// but /health with a plain "back in a few minutes" (503) and writes nothing; the worker takes no jobs (they wait in
// Redis and run once it is back). Nothing reads or writes the database in this mode, so a copy taken now is complete.
export const maintenanceOn = (v = process.env.MAINTENANCE) => /^(1|on|true|yes)$/i.test((v || "").trim());
export const MAINTENANCE_MESSAGE = "Rendrr is being upgraded and is back in a few minutes. Nothing you made is lost.";
