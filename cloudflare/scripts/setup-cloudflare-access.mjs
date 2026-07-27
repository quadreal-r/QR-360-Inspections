/**
 * Configure Cloudflare Access (One-time PIN) for insp360-viewer on krutki11.
 *
 * Mirrors the main map app Access setup (quadreal / late-dream-df75), but on the
 * krutki11 account — Access apps cannot cross Cloudflare accounts.
 *
 * Requires:
 *   CLOUDFLARE_API_TOKEN  — Access Apps/Policies + IdP write (on krutki11)
 *   CLOUDFLARE_ACCOUNT_ID — defaults to krutki11 tour account
 * Optional:
 *   ACCESS_ALLOW_EMAILS   — comma-separated allowlist (defaults = map app list)
 *   APP_HOST              — defaults to insp360-viewer.krutki11.workers.dev
 *   ACCESS_TEAM_NAME      — Zero Trust team name if org must be created
 *
 * Usage:
 *   $env:CLOUDFLARE_API_TOKEN="..."
 *   npm run setup:access
 */
import process from 'node:process'

const ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
  process.env.INSP360_R2_ACCOUNT_ID?.trim() ||
  'e46c718ce72e30e61182c9b1c04cf286'

const TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim()
const APP_HOST = (process.env.APP_HOST || 'insp360-viewer.krutki11.workers.dev').trim()
const APP_HOST_WILDCARD = `*.${APP_HOST}`
// Same allowlist as QR East Industrial Database (quadreal Access wall)
const ALLOW_EMAILS = (process.env.ACCESS_ALLOW_EMAILS ||
  'robert.piwin@quadreal.com,spenser.black@quadreal.com,sureya.shueb@quadreal.com')
  .split(/[,;\s]+/)
  .map((e) => e.trim())
  .filter(Boolean)
const TEAM_NAME = (process.env.ACCESS_TEAM_NAME || 'krutki11-insp360').trim()
const AUTH_DOMAIN = (process.env.ACCESS_AUTH_DOMAIN || `${TEAM_NAME}.cloudflareaccess.com`).trim()

if (!TOKEN) {
  console.error('Set CLOUDFLARE_API_TOKEN, then re-run.')
  console.error('Token needs: Account → Access: Apps and Policies → Edit')
  console.error('             Account → Access: Organizations, Identity Providers, and Groups → Edit')
  console.error('Create on the krutki11 account (e46c718c…), not quadreal.')
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!json.success) {
    throw new Error(`${method} ${path} failed:\n${JSON.stringify(json.errors ?? json, null, 2)}`)
  }
  return json.result
}

async function ensureOrganization() {
  try {
    const org = await api('GET', `/accounts/${ACCOUNT_ID}/access/organizations`)
    console.log(`Zero Trust org: ${org?.auth_domain || org?.name || 'ok'}`)
    return org
  } catch {
    console.log(`Creating Zero Trust organization (${TEAM_NAME})…`)
    return api('POST', `/accounts/${ACCOUNT_ID}/access/organizations`, {
      name: TEAM_NAME,
      auth_domain: AUTH_DOMAIN,
    })
  }
}

async function ensureOtpProvider() {
  const providers = await api('GET', `/accounts/${ACCOUNT_ID}/access/identity_providers`)
  const existing = providers.find((p) => p.type === 'onetimepin')
  if (existing) {
    console.log(`One-time PIN provider already exists: ${existing.id}`)
    return existing
  }
  const created = await api('POST', `/accounts/${ACCOUNT_ID}/access/identity_providers`, {
    name: 'One-time PIN',
    type: 'onetimepin',
    config: {},
  })
  console.log(`Created One-time PIN provider: ${created.id}`)
  return created
}

async function ensureAccessApp(otpId) {
  const apps = await api('GET', `/accounts/${ACCOUNT_ID}/access/apps`)
  const existing = apps.find(
    (a) =>
      a.name === 'INSP 360 Viewer' ||
      a.domain === APP_HOST ||
      a.domains?.includes?.(APP_HOST),
  )
  const payload = {
    name: 'INSP 360 Viewer',
    type: 'self_hosted',
    domain: APP_HOST,
    self_hosted_domains: [APP_HOST, APP_HOST_WILDCARD].filter((v, i, a) => a.indexOf(v) === i),
    session_duration: '168h',
    auto_redirect_to_identity: true,
    allowed_idps: [otpId],
    app_launcher_visible: true,
    policies: [
      {
        name: 'Allow QuadReal editors',
        decision: 'allow',
        include: ALLOW_EMAILS.map((email) => ({ email: { email } })),
      },
    ],
  }

  if (existing) {
    const updated = await api('PUT', `/accounts/${ACCOUNT_ID}/access/apps/${existing.id}`, payload)
    console.log(`Updated Access app: ${updated.id}`)
    console.log(`AUD (set as secret ACCESS_AUD): ${updated.aud}`)
    return updated
  }

  const created = await api('POST', `/accounts/${ACCOUNT_ID}/access/apps`, payload)
  console.log(`Created Access app: ${created.id}`)
  console.log(`AUD (set as secret ACCESS_AUD): ${created.aud}`)
  return created
}

async function main() {
  console.log(`Account: ${ACCOUNT_ID} (krutki11 — NOT quadreal/late-dream-df75)`)
  console.log(`Host:    ${APP_HOST}`)
  console.log(`Emails:  ${ALLOW_EMAILS.join(', ')}`)
  const org = await ensureOrganization()
  const otp = await ensureOtpProvider()
  const app = await ensureAccessApp(otp.id)
  const teamDomain = (org?.auth_domain || AUTH_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, '')
  console.log('')
  console.log('Next:')
  console.log(`  1) wrangler secret put ACCESS_TEAM_DOMAIN   ← ${teamDomain}`)
  console.log(`  2) wrangler secret put ACCESS_AUD           ← ${app.aud || '(see Access app)'}`)
  console.log('  3) Set ACCESS_DISABLE_CHECK = "0" in wrangler.toml and redeploy')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
