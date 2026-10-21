# Rendrr MCP server. Build context: repository root.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile --filter "@rendrr/mcp..."
COPY packages/shared packages/shared
COPY apps/mcp apps/mcp
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
WORKDIR /app/apps/mcp
CMD ["npx", "tsx", "src/server.ts"]
