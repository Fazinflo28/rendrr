# Rendrr

AI video editing workspace. The app is the eyes and hands; the user's own Claude or ChatGPT is the brain.
Rendrr turns footage into text (transcript, silences, scene cuts, key frames), holds the timeline, does the timing maths,
renders, stores and shares. The AI reads small text, decides the edit and sends small instructions through MCP.

| Part | Where | What |
|---|---|---|
| `apps/web` | Railway (`web`), Vercel later | Next.js port of `ui/rendrr-ui.html`, wired to the API |
| `apps/api` | Railway (`api`) | Fastify REST API: every function of the UI's `api` object, plus the AI tools |
| `apps/mcp` | Railway (`mcp`) | MCP server (Streamable HTTP, OAuth via Clerk) for Claude and ChatGPT |
| `apps/worker` | Railway (`worker`) | BullMQ jobs: preview copies, transcription, silences, scene cuts, renders, graphics, cleanup |
| `packages/shared` | | Timeline schema, editing operations, style rules, render plan (timeline → FFmpeg), AI tool list |
| `packages/db` | | Prisma schema, migrations, seed (17 styles, 6 graphic templates) |
| `packages/core` | | Server code shared by API and worker: storage, queues, `applyTimelineChange`, Drive, transcription |

- **Status and links**: [STATUS.md](STATUS.md)
- **Why things are the way they are**: [DECISIONS.md](DECISIONS.md)
- **End-to-end test**: [SMOKE_TEST.md](SMOKE_TEST.md)
- **UI contract**: [ui/rendrr-ui.html](ui/rendrr-ui.html)

## Run locally

```bash
pnpm install
cp .env.example .env              # fill in DATABASE_URL, REDIS_URL, S3_*, CLERK_*, ASSEMBLYAI_API_KEY
pnpm db:migrate && pnpm db:seed
pnpm dev:api                       # :4000
pnpm dev:worker                    # generates the built-in sample footage and music on first start
pnpm dev:mcp                       # :4100
cd apps/web && cp .env.example .env.local && pnpm dev   # :3000
```

The worker needs FFmpeg, Python 3 with `scenedetect` and `opencv-python-headless`, and Chromium (see `apps/worker/Dockerfile`).
