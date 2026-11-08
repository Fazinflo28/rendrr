import { PrismaClient } from "@prisma/client";
import { poolerUrl } from "./url";
export { dbHost, poolerUrl } from "./url";
export * from "@prisma/client";

const g = globalThis as unknown as { __rendrrPrisma?: PrismaClient };
const url = poolerUrl(process.env.DATABASE_URL);
export const prisma: PrismaClient = g.__rendrrPrisma ?? new PrismaClient({ log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"], ...(url ? { datasources: { db: { url } } } : {}) });
if (process.env.NODE_ENV !== "production") g.__rendrrPrisma = prisma;
