import { PrismaClient } from "@prisma/client";
export * from "@prisma/client";

const g = globalThis as unknown as { __rendrrPrisma?: PrismaClient };
export const prisma: PrismaClient = g.__rendrrPrisma ?? new PrismaClient({ log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"] });
if (process.env.NODE_ENV !== "production") g.__rendrrPrisma = prisma;
