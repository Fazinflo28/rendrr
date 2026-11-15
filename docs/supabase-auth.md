# Login through Supabase (replacing Clerk)

The code understands both Clerk and Supabase logins. Clerk stays the login until you flip one switch
(`AUTH_PROVIDER=supabase`). Your edits are safe: a Supabase login opens the account that has the same email.

## What changes for people

- Everyone logs in once more after the switch.
- Google login works straight away.
- People who used a password: click **Forgot password** to set a new one (Clerk cannot hand passwords over).
  Every existing account is given a Supabase login with its email at the switch, so the reset email arrives.
- Claude and ChatGPT: open the connector once and click **Connect** again (it now logs in through Supabase and shows
  a Rendrr page: "Connect Claude to Rendrr?" with Allow).
- The Mac app does not need an update.

## Your steps (once)

### 1. Copy three values from Supabase (project "Rendrr US")

- **Project URL**: Project Settings > Data API (it looks like `https://abcd1234.supabase.co`).
- **Publishable key**: Project Settings > API Keys > Publishable key (`sb_publishable_...`). This one is public.
- **Secret key**: Project Settings > API Keys > Secret keys (`sb_secret_...`; create one if there is none).
  Keep it secret: paste it only into Railway, never into a chat.

### 2. Add them to Railway

Railway > project > Settings > **Shared Variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | the Publishable key |
| `SUPABASE_SECRET_KEY` | the Secret key |

The services already point at these shared names (api2, mcp, web). Do not add `AUTH_PROVIDER` yet.

### 3. Supabase > Authentication > URL Configuration

- **Site URL**: `https://app.rendrr.live`
- **Redirect URLs**: add `https://app.rendrr.live/**` and `https://web-production-9ef14.up.railway.app/**`

### 4. Supabase > Authentication > Sign In / Providers

- **Email**: on, with **Confirm email** on.
- **Google**: on. Paste the Google **Client ID** and **Client secret** (Google Cloud Console > APIs & Services >
  Credentials > the OAuth client Rendrr uses). In that same Google client, add the **Authorized redirect URI** that
  Supabase shows on this page (`https://<your-ref>.supabase.co/auth/v1/callback`) and save.

### 5. Supabase > Project Settings > JWT Keys

Switch to the new signing keys: **Migrate JWT secret**, then **Rotate keys** so the current key is the new
asymmetric one (ES256). The Claude/ChatGPT connector login needs it.

### 6. Supabase > Authentication > OAuth Server

- Turn it **on**.
- **Authorization path**: `/oauth/consent`
- **Allow dynamic client registration**: on (Claude and ChatGPT register themselves).

### 7. Email that reaches everyone: your own sender, and codes in the emails

Supabase's built-in email only delivers to members of your Supabase team (anyone else gets
`email_address_not_authorized`) and only a few an hour. Reset emails and login codes need your own sender:

1. Resend > Domains > Add `rendrr.live`, add the DNS records it shows at your domain host, wait for Verified.
2. Resend > API Keys > create one with Sending access (copy it straight into the next step; do not paste it anywhere else).
3. Supabase > Authentication > Emails > SMTP Settings > Enable custom SMTP: host `smtp.resend.com`, port `465`,
   username `resend`, password the API key, sender `no-reply@rendrr.live`, name `Rendrr`.
4. Supabase > Authentication > Rate Limits: raise "emails sent per hour" (for example to 100).
5. Supabase > Authentication > Emails > Templates: in **Magic Link** and **Reset Password**, add a line
   `Your code: {{ .Token }}`. The login window's "Log in with a code from email" and the reset code use it; the link in
   the email still works too (in the same browser).

### 8. Flip the switch

Railway > Shared Variables > add `AUTH_PROVIDER` = `supabase`. Deploy when Railway asks.

### 9. Check

- Railway > api2 > Logs: each start writes lines beginning `Supabase setup:` (ok / MISSING / ?) for the keys, Google,
  confirm email, the JWT signing key, the OAuth server, the Site URL, each redirect address and Google's redirect URI.
- app.rendrr.live > Log in > Continue with Google: you land in your account with your edits.
- Claude > Settings > Connectors > Rendrr > Connect: a Rendrr page asks "Connect Claude to Rendrr?" > Allow.

**Going back**: delete `AUTH_PROVIDER` in the Shared Variables and deploy. Clerk is the login again.

## How it works (for the code)

- `packages/core/src/supabaseSetup.ts`: the start-up check above (public endpoints and the secret key; prints no values).
- `packages/core/src/supabaseAuth.ts`: checks Supabase tokens (public keys from
  `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, issuer `<SUPABASE_URL>/auth/v1`; older shared-secret tokens are
  asked of `/auth/v1/user`), the admin client (secret key), a login stored as `sb:<user id>` in `User.clerkId` /
  `UserLogin.clerkId`.
- API (`apps/api/src/auth.ts`): a Supabase token opens the account of its login, or the account that has its verified
  email, or a new one (refused while `SIGNUP_ALLOWLIST` is set and the email is not on it). At start-up with the
  switch on, `services/supabaseImport.ts` gives every account a Supabase login with its email.
- Mac app: the browser's Allow becomes a one-time magic link token (`/auth/desktop/redeem` returns `tokenHash`), which
  the app trades for its own session.
- MCP (`apps/mcp/src/supabase.ts`): publishes Supabase as the authorization server
  (`/.well-known/oauth-protected-resource`), serves its metadata, checks the token.
- Web (`apps/web/src/rendrr/supa.ts`, `api.ts`, `app.js`): email and password, Google (`/auth/callback`), reset
  (`/reset-password`, or the code), the connector's consent page (`/oauth/consent`). Built in when
  `NEXT_PUBLIC_AUTH_PROVIDER=supabase` with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Tests: `apps/api/test/supabase-auth.test.ts` (a stand-in Supabase with real signed tokens),
  `apps/mcp/test/supabase.test.ts`, `apps/web/demo/oauth-consent.mjs`.
