# Agency School Shop

A small job marketplace. A buyer orders a WordPress site package, pays by card, and the **first contractor to click Claim gets the job**. The site is created on the **owner's hosting**, the contractor builds it, and the buyer is emailed the site link, page count and a one-time WordPress login link. The owner keeps 60% of each order (minus card fees) and the contractor earns 40%. Payouts are weekly and only the owner sees the full picture.

Live at **https://shop.theagencyschool.com** (Cloudflare Workers, deployed automatically from `main`).

Stack: Node 18+, Express, Supabase (Postgres + Supabase Auth), Stripe Checkout, SMTP email. No build step. Runs on Cloudflare Workers (`npm run deploy`) or any Node server (`npm start`).

## 1. Create the Supabase project

1. Create a project at supabase.com. From **Project Settings > API** copy the Project URL, the `anon` key and the `service_role` key.
2. `cp .env.example .env` and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Never commit `.env` (it is in `.gitignore`), and never put the service role key in browser code.
3. Create the tables with the Supabase CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR-PROJECT-REF
   npx supabase db push
   ```

   This runs `supabase/migrations/0001_init.sql`: the tables, the three starter packages, the `claim_order()` lock and row level security. You can also paste that file into the dashboard's SQL Editor and run it once.
4. In **Authentication > URL Configuration**, set **Site URL** to your `APP_URL` and add `APP_URL/**` to **Redirect URLs** (invite and reset links only come back to allowed addresses).
5. In **Authentication > SMTP Settings**, enter your SMTP details. Supabase sends the contractor invites and password-reset emails, and its built-in mailer only sends a few emails an hour, only to your own team.
6. Create the owner account:

   ```bash
   npm install
   npm run create-admin -- "Owner Name" owner@example.com "a-strong-password"
   ```

   This creates the Supabase Auth user and sets `role='admin'` in `profiles`. Running it again for the same email resets that password.

## 2. Run it locally (dev mode, no Stripe, no email)

```bash
npm start            # http://localhost:3000
```

In dev mode the "pay" step is a fake button and the shop's own emails print to the console.

## 3. Test

```bash
npm test
```

The test runs the whole flow against Supabase: sign-up and login, the two-way claim race plus 20 simultaneous `claim_order()` calls, the missed-deadline exclusion, reminders, the dispute hold, refunds, roles, payouts and CSV, auto-approve, password reset, token refresh and row level security. It creates its own users, package and orders and deletes them at the end. It also runs `tick()` over **every** order in the database, so it will reopen, remind or auto-approve real orders that are due. Run it before launch or against a separate test project.

- **Local Supabase** (needs Docker): `npx supabase start`, put the printed URL and keys in `.env.test`, then run `npm test`. The contractor invite email is tested too and lands in the local Mailpit inbox.
- **A hosted project**: settings come from `.env.test` if it exists, otherwise `.env`. The test refuses to run against a hosted project unless you confirm with `SMOKE_TEST_REMOTE=yes npm test`. Against a hosted project it skips the invite email, so it does not send real email.

## 4. Go live on Cloudflare Workers

The same Express app runs on Workers (`src/worker.js`, `wrangler.jsonc`). A Cron Trigger runs the minute-by-minute checks (`tick`).

1. Set `APP_URL` and `MAIL_FROM` in `wrangler.jsonc` under `vars`.
2. Log in and store every secret in Cloudflare (each command asks for the value):

   ```bash
   npx wrangler login
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_ANON_KEY
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put SMTP_HOST      # plus SMTP_PORT (587), SMTP_USER, SMTP_PASS
   npx wrangler secret put PROVISION_URL  # plus LOGIN_LINK_URL and PROVISION_TOKEN
   ```

3. `npm run deploy`, then add the custom domain (e.g. `shop.theagencyschool.com`) under the Worker's **Settings > Domains & Routes**.
4. In Stripe, add a webhook to `APP_URL/webhooks/stripe` for the event `checkout.session.completed`.
5. Log in as the owner, open **Contractors** and invite everyone (Supabase emails them a link to set their password), then edit **Packages** to set real prices.

On Workers, SMTP must use port 587 (`SMTP_SECURE=false`), because port 465 is blocked. Workers cannot run shell commands, so the provisioning hooks use `PROVISION_URL` and `LOGIN_LINK_URL` (see below).

### Or on a Node server

Fill in `.env` (including `SMTP_*`, `PROVISION_CMD` and `LOGIN_LINK_CMD`), run `npm start` behind HTTPS (nginx or Caddy) and keep it running with pm2 or systemd. Supabase backs up the database.

## Logins (Supabase Auth)

- **Buyers** sign up with email and password and are logged in straight away. **Forgot your password?** on the login page sends a Supabase reset email.
- **Contractors** are invited from **Admin > Contractors** (`inviteUserByEmail`). The link signs them in and asks them to set a password.
- **The owner** is created with `npm run create-admin`.
- The server keeps the Supabase access and refresh tokens in httpOnly, SameSite=Lax cookies. It checks the access token with Supabase on every request, refreshes it when it expires, and loads the role from `profiles`. Disabling a contractor takes effect on their next click.
- Email links come back to `/auth/callback` (Supabase's default templates). If you prefer server-verified links, change the Invite and Reset Password email templates to link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (or `type=recovery`).

## The rules the app enforces

| Rule | Where |
| --- | --- |
| First to claim wins (atomic single UPDATE in Postgres) | `claim_order()` in `supabase/migrations/0001_init.sql`, called by `claimJob` in `src/jobs.js` |
| Deadline starts at claim: 24h or 72h, chosen by the buyer | `claim_order()` |
| Reminders at 50% and 90% of the time | `tick` |
| Missed deadline: job reopens, that contractor is excluded from it, owner is alerted | `reopenAndExclude`, `tick` |
| Nobody claims within 2h: owner alerted and contractors emailed again (once) | `tick` |
| Buyer reminded 12h before auto-approval; auto-approves after 48h | `tick` |
| Contractor pay is recorded only when the order is approved | `approve` |
| Dispute = contractor pay held (escrow); owner releases or refunds | `setDispute`, `refund` |
| Card fee comes out of the owner's share (estimate 2.9% + 30c, replaced by the real Stripe fee from the webhook) | `markPaid`, webhook |
| Owner is also a contractor: an owner-claimed job creates no payout | `approve` |
| Contractors never see the buyer's email or phone, only first name and the brief | `/jobs/:id` |
| Contractor sees only their own jobs and earnings | `/jobs`, `/earnings` |
| Buyer's WordPress password is never emailed, only a one-time link | `markDone`, `createLoginLink` |
| Signed-in users can read only their own rows and write nothing directly (second layer; the server uses the service role) | RLS policies in the migration |

The percent split is a setting per package (Admin > Packages). Change it there, not in code.

## Provisioning WordPress on the owner's hosting (the part Haseeb must finish)

`src/provision.js` has two hooks. Each returns ONE JSON object.

- **Create the site** runs when a contractor claims a job and returns `{"siteUrl":"...","adminUrl":"...","username":"..."}`.
- **Login link** runs when the contractor marks the job done and returns `{"loginUrl":"..."}`, a one-time link where the buyer sets their WordPress password.

On a Node server they are shell commands: `PROVISION_CMD <orderId> <businessName> <domain>` and `LOGIN_LINK_CMD <orderId> <username>`, each printing the JSON line.

On Cloudflare Workers they are HTTPS calls: `PROVISION_URL` gets `{"orderId","businessName","domain"}` and `LOGIN_LINK_URL` gets `{"orderId","username"}`, both with `Authorization: Bearer $PROVISION_TOKEN`. `scripts/provision-server.example.js` is a small server for the hosting box that checks the token and runs the same shell scripts.

`scripts/provision-wp.example.sh` and `scripts/wp-login-link.example.sh` are WP-CLI starting points. They do not install Avada or create the web server config. Adapt them to the hosting panel in use. Each buyer supplies their own Avada license purchase code (it is a required field and is shown to the claimed contractor), and Avada is installed with that code.

## Known gaps (not built yet)

- Terms of service and refund policy pages. Have a lawyer review them.
- Rate limiting on login (Supabase Auth has its own limits), and CSRF tokens (cookies are SameSite=Lax, which covers most cases).
- Stripe Connect or automatic payouts. By design, payouts are manual: the report at Admin > Payouts lists what is owed, and "Mark paid" records it after you pay by Zelle, PayPal or Wise.
- W-9 and 1099 tracking. Collect a W-9 from each US contractor before their first payout.
- Whether repeated missed deadlines should remove a contractor from the shop, and whether contractors can unclaim a job (open questions with the owner).

## Files

```
src/server.js         all routes and pages
src/worker.js         Cloudflare Workers entry (Express + Cron Trigger for tick)
src/jobs.js           business rules (claim, deadlines, approval, escrow, payouts)
src/db.js             Supabase clients (service role for the server, anon for sign-in)
src/auth.js           Supabase Auth sessions in httpOnly cookies, role checks
src/provision.js      hooks that create the WordPress site
src/mail.js           email (prints to console when SMTP is not set)
src/views.js          tiny HTML templates
supabase/migrations/  Postgres schema, claim_order(), row level security, starter packages
scripts/              create-admin, provisioning examples, smoke test
wrangler.jsonc        Cloudflare Workers settings
```
