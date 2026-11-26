# Plans, billing, costs and the admin panel

How Rendrr charges, what it costs us, and the steps to switch payments on.

## The plans

| | Free trial | Starter |
|---|---|---|
| Price | Free for 7 days, no card | $5 a month |
| Export minutes (finished video) | 10 | 25 |
| Footage minutes (uploaded and processed) | 30 | 60 |
| Preview minutes | 60 | Free, no limit |
| Storage | 5 GB | 10 GB |
| Quality | Up to 1080p | 4K too (counts double) |
| After the allowance | Stops (start Starter) | Pay as you go, up to the spending limit |

What a trial makes, in real videos:

- About 10 short videos of a minute each (Reels, Shorts, TikToks), or one 10-minute YouTube video.
- 30 minutes of raw footage in. A 1-minute short usually needs 2 to 3 minutes of footage, so 10 shorts fit.
- 60 preview minutes: about 3 to 6 previews per short, enough to review and fix each one.
- Every feature is open (captions, motion graphics, color, sound, Mac and Drive export). Only 4K is held back.
- A last export may run 1 minute past the allowance, so a 10.5-minute video is not refused for 30 seconds.

Pay as you go on Starter (after the 25 export minutes, 60 footage minutes and 10 GB):

- $0.10 an export minute. 4K exports and heavy effects (subject mask, stabilize, optical-flow slow motion, morph cut,
  tracking) count 2 minutes per minute.
- $1.00 an hour of footage processed ($0.0167 a minute).
- $0.10 a GB a month of storage over 10 GB, counted by the day.
- Each account has a spending limit, $20 a month to start. The user can change it on Usage & billing (0 means
  nothing past the $5). When it is reached, exports pause until the next month or until they raise it.

Examples of a month on Starter:

| Month | Export min | Footage min | Bill |
|---|---|---|---|
| 20 shorts of 1 minute | 20 | 50 | $5.00 |
| 50 shorts of 1.5 minutes | 75 | 150 | $5 + $5.00 + $1.50 = $11.50 |
| 6 YouTube videos of 12 minutes | 72 | 180 | $5 + $4.70 + $2.00 = $11.70 |

## Local-first renders (switch, off for now)

Rendrr renders on the user's own Mac or PC whenever the Rendrr app is open, and on Rendrr's cloud only when it is
closed. With `LOCAL_RENDERS_FREE=1` set on the worker, a render made on the user's computer is still recorded but
bills 0 minutes: only cloud renders count toward the allowance and the pay-as-you-go charge after it, on the next
bill. Leave it unset until the plan and prices are final; nothing changes while it is off.

## What it costs us (measured, not guessed)

The worker measures every job: the container's CPU and memory every 2 seconds (cgroup counters), shared among the
jobs running at the time by how heavy each kind is (render 8, graphic 6, subject matte 6, proxy 4, analyze 0.5 and so
on). Transcription seconds and bytes sent out are noted by the job itself. Storage is measured once a day per user.
Idle time is saved too, so nothing is missed.

Rates used (from Railway's and AssemblyAI's price pages):

- CPU $20 a vCPU-month, memory $10 a GB-month (Railway).
- Transcription $0.15 an hour of audio (AssemblyAI Universal-2).
- Data sent out of a service $0.05 a GB (Drive saves, uploads to the bucket). Bucket downloads are free.
- Storage $0.015 a GB-month (Railway bucket).
- Stripe 2.9% + 30 cents a charge.
- Fixed costs (API, web, database, Redis) as one number: `FIXED_COST_MONTHLY_USD`, default $15.

The admin panel shows the real cost of one export minute once there is usage. Before launch, estimates were about
1 to 3 cents an export minute, which keeps the margin above 80% at $0.10.

## The pages

- **Usage & billing** (`/usage`, menu: Usage & billing): the plan and its period, money so far, the estimated bill,
  the spending limit (Edit), a meter for each allowance, a day-by-day chart, the pay-as-you-go lines, usage by
  project and storage. The Billing tab (`/billing`) shows both plans, the card (Stripe's page) and invoices.
- **Admin** (`/admin`, menu: Admin, only for admins): Overview (MRR, money in, our cost, margin, users, cost by day,
  where the money goes, usage, problems, queues), Users (search, filter, sort; open one to see everything and give
  more trial days, complimentary access, bonus minutes or a new limit; each change is logged), Costs (by day, by kind
  of job, per export minute, users who cost most), Storage, Issues (failed jobs and renders grouped by error, stuck
  work, AI tool errors, errors in people's browsers with Mark fixed) and Jobs (the job log).
- When a render or upload is refused for the plan, the web app shows a dialog with the reason and a button to Usage &
  billing, and the AI gets the same reason as text.

## Switch payments on (owner steps)

Until a Stripe key is set, nothing is charged and nothing is blocked. Accounts still get a trial and their usage
and our costs are measured, so the pages show real numbers.

1. **Stripe account.** Sign in at dashboard.stripe.com. Use Test mode first.
2. **The product.** Product catalog, Add product: name "Rendrr Starter", recurring price $5.00 a month. In the price's
   advanced options set the **lookup key** to `rendrr_starter_monthly`. (Or copy the price id and put it in Railway as
   `STRIPE_PRICE_STARTER`.)
3. **Customer portal.** Settings, Billing, Customer portal: turn on "Cancel subscriptions" and "Update payment method".
4. **Webhook.** Developers, Webhooks, Add endpoint:
   - URL: `https://api-production-2428.up.railway.app/billing/webhook` (or `https://api.rendrr.live/billing/webhook`
     once that domain points to `api2`).
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.voided`,
     `invoice.marked_uncollectible`, `invoice.payment_failed`.
   - Copy its **Signing secret** (starts with `whsec_`).
5. **Railway**, service `api2`, Variables (paste them there yourself, never in a chat):
   - `STRIPE_SECRET_KEY` = the secret key (Developers, API keys; `sk_test_` first, `sk_live_` at launch).
   - `STRIPE_WEBHOOK_SECRET` = the signing secret from step 4.
   - `ADMIN_EMAILS` = the emails that get the admin panel, comma separated (already set to the owner's email).
6. **Test.** Log in with a test account, open Usage & billing, Start Starter, pay with card 4242 4242 4242 4242, any
   future date and any CVC. You come back to "Thanks. Starter is on". The admin panel shows the account on Starter.
7. **Go live.** Do steps 2 to 5 again in Live mode with the live key and the live webhook's secret.

Optional switches on `api2`:

- `BILLING_ENFORCE=off` keeps everything measured but blocks nothing, even with a Stripe key (a soft launch).
  `BILLING_ENFORCE=on` blocks without a Stripe key (only for testing).
- `FIXED_COST_MONTHLY_USD` changes the fixed monthly cost used for the margin (default 15).

## How a month is billed

- Starting Starter opens Stripe Checkout. Stripe charges $5 at once and every month after.
- When Stripe makes the next month's invoice (`invoice.created`), Rendrr adds the pay-as-you-go lines for the month
  that just ended (export minutes, footage hours, storage), so one invoice holds the $5 and the usage.
- Cancelling (in Stripe's page) keeps Starter until the period ends; then a last invoice for any usage of 50 cents or
  more is sent, and the account stops exporting until Starter is started again. Edits and videos are kept.
- A failed payment sets the account to "payment failed": exports pause until the card is updated.
- Every Stripe event is kept once (no double handling), and each usage record has one id per render or video, so
  nothing is billed twice.

## Where the code is

- Plans, rates and the bill: `packages/shared/src/billing.ts` (tests: `packages/shared/test/billing.test.ts`).
- Usage, periods, admins: `packages/core/src/billing.ts`. Cost notes: `packages/core/src/cost.ts`.
- Worker cost meter: `apps/worker/src/lib/cost.ts` (test: `apps/worker/test/cost-meter.test.ts`).
- API: `apps/api/src/services/billing.ts`, `stripe.ts`, `admin.ts`; routes `billing.ts`, `admin.ts`
  (test: `apps/api/test/billing.test.ts`, with a fake Stripe and real webhook signatures).
- Web: `apps/web/src/rendrr/billing.js`, `admin.js` (tests: `apps/web/demo/usage-billing.mjs`,
  `apps/web/demo/admin-panel.mjs`).
- Database: `packages/db/prisma/migrations/20261107200000_billing_costs` (UsageRecord, JobCost, StorageSnapshot,
  BillingInvoice, ClientError, AdminAction, StripeEvent; plan fields on User).
