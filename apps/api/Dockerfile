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
# Migrations and the built-in content seed run on every start (both are idempotent).
CMD ["sh", "-c", "cd /app/packages/db && npx prisma migrate deploy && npx tsx src/seed.ts && cd /app/apps/api && exec npx tsx src/server.ts"]
