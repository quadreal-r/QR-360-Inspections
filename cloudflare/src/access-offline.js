/**
 * Panic kill-switch: app_settings key `access_offline`.
 * Cuts HTML / non-admin access without deleting data or accounts.
 *
 * Same behaviour as QR-East_Industrial_Database (functions/lib/accessOffline.ts),
 * backed by D1 (`INSP360_DB`) instead of Supabase.
 */

export const PULL_THE_PLUG_EMAIL = 'pulltheplug@quadreal.com'
export const ACCESS_OFFLINE_KEY = 'access_offline'

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

export function isPullThePlugEmail(email) {
  return normalizeEmail(email) === PULL_THE_PLUG_EMAIL
}

export function parseAccessOfflineValue(value) {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return false
    }
  }
  if (!parsed || typeof parsed !== 'object') return false
  return parsed.offline === true
}

export function buildAccessOfflineValue(offline, meta) {
  const value = {
    offline: !!offline,
    setAt: new Date().toISOString(),
  }
  const setBy = meta?.setBy ? normalizeEmail(meta.setBy) : ''
  if (setBy) value.setBy = setBy
  return value
}

/** Read the Offline flag. Never throws — a broken read must not lock people out. */
export async function getAccessOffline(env) {
  if (!env?.INSP360_DB) return false
  try {
    const row = await env.INSP360_DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(ACCESS_OFFLINE_KEY)
      .first()
    return parseAccessOfflineValue(row?.value)
  } catch (err) {
    console.error('access_offline read failed', err?.message || err)
    return false
  }
}

export async function setAccessOffline(env, offline, meta) {
  if (!env?.INSP360_DB) throw new Error('Offline switch is not configured (ACL database).')
  const value = buildAccessOfflineValue(offline, meta)
  try {
    await env.INSP360_DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
      .bind(ACCESS_OFFLINE_KEY, JSON.stringify(value))
      .run()
  } catch (err) {
    console.error('access_offline write failed', err?.message || err)
    throw new Error('Could not update offline status.')
  }
}

/** True only when email has role `admin` in the users table. */
export async function isAppAdmin(email, env) {
  const normalized = normalizeEmail(email)
  if (!normalized.includes('@') || !env?.INSP360_DB) return false
  try {
    const row = await env.INSP360_DB.prepare(
      'SELECT role FROM users WHERE email = ? COLLATE NOCASE',
    )
      .bind(normalized)
      .first()
    return row?.role === 'admin'
  } catch (err) {
    console.error('admin lookup failed', err?.message || err)
    return false
  }
}

/** Decide how /api/auth/request-code should behave given offline state. */
export function decideOfflineCodeRequest(input) {
  if (isPullThePlugEmail(input.email)) return { action: 'pull_plug' }
  if (!input.offline) return { action: 'continue' }
  if (input.isAdmin) return { action: 'continue' }
  return {
    action: 'block_non_admin',
    error: 'The app is offline. Only an Admin can sign in to restore access.',
  }
}

/** After a valid OTP, decide offline gate behaviour. */
export function decideOfflineVerify(input) {
  if (!input.offline) return { action: 'continue' }
  if (!input.isAdmin) {
    return {
      action: 'refuse',
      error: 'The app is offline. Only an Admin can restore access.',
    }
  }
  return { action: 'clear_offline' }
}
