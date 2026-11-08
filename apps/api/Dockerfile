# Rendrr API server. Build context: repository root.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@rendrr/api..." --filter "@rendrr/db"
COPY packages packages
COPY apps/api apps/api
RUN cd packages/db && npx prisma generate
ENV NODE_ENV=production
EXPOSE 8080
ENV PORT=8080
# Migrations and the built-in content seed run on every start (both are idempotent). Migrations use DIRECT_URL when it
# is set (Supabase's Session pooler: the Transaction pooler cannot run them); the app itself uses DATABASE_URL.
# In maintenance mode (MAINTENANCE=1) neither runs: nothing may write while the database is copied.
CMD ["sh", "-c", "cd /app/packages/db && case \"$MAINTENANCE\" in 1|on|true|yes) ;; *) DATABASE_URL=\"${DIRECT_URL:-$DATABASE_URL}\" npx prisma migrate deploy && npx tsx src/seed.ts ;; esac && cd /app/apps/api && exec npx tsx src/server.ts"]
