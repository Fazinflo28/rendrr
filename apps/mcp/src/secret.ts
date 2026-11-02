import { createHmac } from "node:crypto";

/**
 * The secret sent to the API with each tool call: INTERNAL_API_SECRET when it is set, else one worked out from the
 * Clerk secret key (which the API holds too), so no other secret has to be copied between the two services. Worked
 * out as packages/core/src/crypto.ts internalSecretFromClerk does (a test keeps the two equal).
 */
export const internalSecretFromClerk = (clerkSecret: string) => createHmac("sha256", clerkSecret).update("rendrr-internal-api-v1").digest("hex");
export const internalSecret = () => process.env.INTERNAL_API_SECRET || (process.env.CLERK_SECRET_KEY ? internalSecretFromClerk(process.env.CLERK_SECRET_KEY) : "");
