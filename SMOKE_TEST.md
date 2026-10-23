# Smoke test

One command checks the whole product end to end and prints **PASS** or **FAIL** for every step.

## What it does

1. API is healthy (database and Redis reachable)
2. Logs in as the test user (a real Clerk session)
3. Adds the built-in sample footage
4. Waits for analysis: preview copy, transcript (AssemblyAI), silences, scene cuts, key frames, reading the frames
5. Checks the **breakdown**: shots, pacing, beat, and that a contact sheet loads
6. Creates a project folder
7. Creates an edit with style **Bold Talking Head** (the style's rules run as the first pass)
8. AI tools, through the same path the MCP server uses: `get_footage` (breakdown text + contact sheets), `get_frames` (two exact moments), `apply_style` (Fast UGC Ad) and `cut_silences`
9. Editor autosave (timeline replace with version check)
10. Renders a **preview** and follows the live progress stream (the same one the editor's progress bar uses), then checks the file plays
11. Renders the **final** (1080p) and checks size and length
12. Creates a password-protected **review link**
13. Opens it as the client (locked, then unlocked with the password), checks the video link
14. Client adds a comment at 0:04
15. Editor resolves the comment
16. Client approves (project status becomes Approved)
17. Adds a **reference video** and waits until it is read like footage
18. AI: `list_references` finds it, `get_reference` returns its breakdown and sheets
19. Deletes the reference and checks its contact sheets are gone
20. Usage page numbers
21. Cleans up: deletes the test folder (its edits, renders and review links go with it) and the footage

The AI steps need `INTERNAL_API_SECRET`; without it the test has 19 steps. The test uses the API's built-in sample footage (`POST /videos/sample`), which the web app no longer offers.

## Run it

Against the live servers:

```bash
API_URL=https://api-production-2428.up.railway.app \
CLERK_SECRET_KEY=sk_test_... \
INTERNAL_API_SECRET=... \
pnpm smoke
```

- `CLERK_SECRET_KEY` (Clerk dashboard → API keys) lets the test create its own test user and session. It only works on a Clerk **development** instance.
- `INTERNAL_API_SECRET` (Railway → api service → Variables) is optional; it adds the AI tool steps.
- Needs `ffprobe` on your machine to check the rendered files.
- Behind an HTTPS proxy (for example a cloud sandbox), add `NODE_USE_ENV_PROXY=1 http_proxy=$HTTPS_PROXY`: Node's fetch and ffprobe do not read `HTTPS_PROXY` by themselves, and without it every step fails with "fetch failed".

Against a local stack (`pnpm dev:api`, `pnpm dev:worker`, with Postgres, Redis and an S3-compatible store set in `.env`):

```bash
set -a; . ./.env; set +a; pnpm smoke
```

Expected output ends with `17/17 steps passed. PASS`. It takes about one minute: most of it is transcription and the final render.

## Test the AI connector (MCP)

**With Claude Code** (the quickest way):

```bash
claude mcp add --transport http rendrr https://mcp-production-7fa0.up.railway.app/mcp
claude            # then type /mcp, pick rendrr, and log in when the browser opens
```

Then ask: *"List my footage in Rendrr, apply the Bold Talking Head style to the sample, cut silences, render a preview and show me the frames."*

**With Claude.ai**: Settings → Connectors → Add custom connector → paste `https://mcp-production-7fa0.up.railway.app/mcp`, name it Rendrr. Clerk asks you to log in and press **Allow** once.

**With the MCP Inspector**: `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL as above, then "Open Auth Settings" → Quick OAuth Flow.

**Scripted** (what I used to verify it): logs in like Claude does (dynamic client registration, PKCE, Clerk sign-in, consent), then calls every main tool:

```bash
node scripts/mcp-oauth-login.mjs https://mcp-production-7fa0.up.railway.app/mcp   # saves .mcp-token
MCP_URL=https://mcp-production-7fa0.up.railway.app/mcp MCP_TOKEN=$(cat .mcp-token) pnpm tsx scripts/mcp-check.ts --render
```

The test user is `smoke+clerk_test@rendrr.dev` / `Rendrr-Smoke-Test-2026!` (Clerk test address: any verification code is `424242`).

## Unit tests

```bash
pnpm --filter @rendrr/shared test     # timeline operations and the render plan
```
