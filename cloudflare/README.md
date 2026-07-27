# INSP 360 Viewer — Cloudflare (krutki11)

Standalone viewer with:

- **QuadReal branded OTP login wall** (Resend email codes + `insp360_session` cookie)
- **R2** bucket `insp360` for cloud tours (via `/api/tours`)
- **D1** ACL (`users` / groups / grants) — only allowlisted emails receive codes
- **Local** `.insp360` projects still open/save on this PC

No Building Map Explorer gateways. Cloudflare Access is **not** the primary gate (disable any Access app on the Worker hostname so the branded wall is visible).

## Quick start (upload works today)

Production Worker deploy needs krutki11 login. Until then, use the **local API** (uses your existing `INSP360_R2_*` keys from East Industrial `.env.local`):

```powershell
cd C:\Users\Robert\Projects\QR-360-Inspections\cloudflare
npm install
npm run local-api
```

Then open **http://127.0.0.1:8788/** (not `file://`). **Upload to cloud**, **Cloud tours**, and **Admin** use the same ACL model as production (local SQLite at `cloudflare/.data/insp360-acl.sqlite`). Default user is `robert.piwin@quadreal.com` — override with `?as=email@…` or header `X-Insp360-Email`. Local API skips Resend; no OTP email is required. Note: local SQLite is separate from production D1.

## GitHub Actions deploy

Pushing to `main` (or running **Actions → Deploy → Run workflow**) deploys the Worker when `cloudflare/` or `QR-360-Inspections/` change.

### One-time GitHub secret

1. Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token**
2. Use template **Edit Cloudflare Workers** (must be able to write Workers / R2 / D1)
3. Account resources: **krutki11** (`e46c718ce72e30e61182c9b1c04cf286`)
4. GitHub → repo **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: the token

Runtime Worker secrets (`SESSION_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`) stay on Cloudflare (`wrangler secret put`) — they are not set by this workflow.

Live URL after deploy: https://insp360-viewer.krutki11.workers.dev

## Production deploy (manual)

```powershell
cd C:\Users\Robert\Projects\QR-360-Inspections\cloudflare
npm install
npm run sync-viewer
# Apply D1 migrations (first time / after new SQL files):
npx wrangler d1 migrations apply insp360-acl --remote
npm run deploy
```

Account ID (krutki11): `e46c718ce72e30e61182c9b1c04cf286`  
Bucket: `insp360`  
D1: `insp360-acl`

**Live URL:** [https://insp360-viewer.krutki11.workers.dev](https://insp360-viewer.krutki11.workers.dev)  
(Account login: `krutki11@gmail.com`, workers.dev subdomain: `krutki11`)

### Required secrets

```powershell
npx wrangler secret put SESSION_SECRET
# random 32+ byte string — HMAC for insp360_session cookie (7-day TTL)

npx wrangler secret put RESEND_API_KEY
# from https://resend.com

npx wrangler secret put RESEND_FROM
# e.g. INSP 360 <noreply@your-verified-domain>
```

Verify the Resend **from** domain before expecting OTP email delivery.

### Disable Cloudflare Access on the Worker hostname

If an Access app still wraps `insp360-viewer.krutki11.workers.dev`, Cloudflare’s OTP page will intercept before the QuadReal wall.

1. Open Zero Trust → Access → Applications
2. Find the app for `insp360-viewer.krutki11.workers.dev` (or Workers one-click Access)
3. Disable or delete it

Or, if you have an API token with Access edit: remove the application via the dashboard / Access API.

`ACCESS_DISABLE_CHECK = "1"` in `wrangler.toml` only skips leftover Access JWT validation in the Worker; it does **not** turn off edge Access.

### Deploy auth (required)

Wrangler must be logged into the **krutki11** Cloudflare account (`e46c718ce72e30e61182c9b1c04cf286`), not a personal Gmail-only account.

```powershell
# Option A — interactive login (pick krutki11 in the browser)
npx wrangler logout
npx wrangler login

# Option B — API token scoped to krutki11
$env:CLOUDFLARE_API_TOKEN = "paste-token-with-Workers+R2+D1"
npm run deploy
```

If deploy prints that `account_id` does not match authenticated accounts, you are on the wrong Cloudflare login.

## Auth wall (QuadReal OTP)

Unauthenticated visits to `/` get the branded two-step wall:

1. Enter work email → **Send code**
2. UI shows **We sent a code to {email}** → enter 6-digit code → **Verify**

Only emails already in D1 `users` receive mail (admins add people in Admin → People). Unknown emails still get a generic success response (anti-enumeration) but no email is sent.

Once signed in, use **Log out** next to the top identity chip — it `POST`s `/api/auth/logout`, clears the session cookie, and returns to the branded wall.

Seeded admin: `robert.piwin@quadreal.com` (see `migrations/0002_seed_admin.sql`).

## Local / cloud in the viewer

| Badge | Meaning |
|-------|---------|
| **Local** | Opened from this PC; Save writes to the disk file handle |
| **Cloud** | Opened from R2; Save PUTs to the same cloud key |

Local projects show **Upload to cloud**. After upload, re-open from the Cloud list to stay cloud-connected.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness (no auth) |
| POST | `/api/auth/request-code` | Request OTP email `{ email }` (public) |
| POST | `/api/auth/verify` | Verify OTP → set `insp360_session` cookie |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/me` | Current user + `logoutUrl` |
| GET | `/api/tours?prefix=` | List `.insp360` keys |
| GET | `/api/tours/:key` | Download tour bytes |
| GET | `/api/tours/:key/cover` | Cover thumbnail |
| PUT | `/api/tours/:key/cover` | Upload cover |
| GET | `/api/tours/:key/tour` | Pin/map sidecar (`….tour.json`) |
| PUT | `/api/tours/:key/tour` | Upload pin/map sidecar (fast pin saves) |
| PUT | `/api/tours/:key` | Upload / overwrite full tour |
| DELETE | `/api/tours/:key` | Delete tour + cover + tour.json sidecars |

## What you must provide / paste

| # | Item | Example / notes |
|---|------|-----------------|
| 1 | Confirm **krutki11** hosting | Account ID `e46c718ce72e30e61182c9b1c04cf286` |
| 2 | `SESSION_SECRET` | Random secret for cookie HMAC |
| 3 | Resend | `RESEND_API_KEY` + `RESEND_FROM` (verified domain) |
| 4 | Allowlisted users | Add in Admin → People (or D1 `users`) |
| 5 | Disable edge Access | So the QuadReal wall is reachable |
| 6 | Auth for deploy | `npx wrangler login` **on krutki11**, or `CLOUDFLARE_API_TOKEN` with Workers + R2 + D1 |

Viewer source of truth: `QR-360-Inspections/QR-360-Inspections_v*.html` (synced into `public/index.html` on deploy).
