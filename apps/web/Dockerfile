# Rendrr web app (Next.js). Build context: repository root. Runs on Railway until a Vercel project exists.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@rendrr/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
# Public settings baked into the browser bundle at build time (Railway passes service variables as build args).
# Supabase Auth: NEXT_PUBLIC_AUTH_PROVIDER=supabase switches the login from Clerk (the publishable key is public).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_AUTH_PROVIDER
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_AUTH_PROVIDER=$NEXT_PUBLIC_AUTH_PROVIDER NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
RUN pnpm build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec npx next start -p ${PORT:-8080} -H 0.0.0.0"]
