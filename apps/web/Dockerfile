# Rendrr web app (Next.js). Build context: repository root. Runs on Railway until a Vercel project exists.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@rendrr/web..."
COPY apps/web apps/web
# Public settings baked into the browser bundle at build time (Railway passes service variables as build args).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
RUN pnpm build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec npx next start -p ${PORT:-8080} -H 0.0.0.0"]
