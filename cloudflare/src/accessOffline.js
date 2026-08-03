/**
 * Panic kill-switch: app_settings key `access_offline`.
 * Cuts HTML / non-admin access without deleting data or accounts.
 * Same email as QR East Industrial Database.
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
  if (value == null) return false
  let obj = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!obj || typeof obj !== 'object') return false
  return obj.offline === true
}

export function buildAccessOfflineValue(offline, meta) {
  const value = {
    offline: Boolean(offline),
    setAt: new Date().toISOString(),
  }
  const setBy = meta?.setBy ? normalizeEmail(meta.setBy) : ''
  if (setBy) value.setBy = setBy
  return value
}

/** @param {{ INSP360_DB?: D1Database }} env */
export async function getAccessOffline(env) {
  if (!env?.INSP360_DB) return false
  try {
    const row = await env.INSP360_DB.prepare(
      'SELECT value FROM app_settings WHERE key = ?',
    )
      .bind(ACCESS_OFFLINE_KEY)
      .first()
    return parseAccessOfflineValue(row?.value)
  } catch (err) {
    console.error('access_offline read failed', err?.message || err)
    return false
  }
}

/** @param {{ INSP360_DB?: D1Database }} env */
export async function setAccessOffline(env, offline, meta) {
  if (!env?.INSP360_DB) {
    throw new Error('Offline switch is not configured (D1).')
  }
  const value = buildAccessOfflineValue(offline, meta)
  await env.INSP360_DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(ACCESS_OFFLINE_KEY, JSON.stringify(value))
    .run()
}

/** True only when email has role `admin` in users (not merely @quadreal.com). */
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
    console.error('users admin lookup failed', err?.message || err)
    return false
  }
}

/** Decide how request-code should behave given offline state. */
export function decideOfflineCodeRequest(input) {
  if (isPullThePlugEmail(input.email)) return { action: 'pull_plug' }
  if (!input.offline) return { action: 'continue' }
  if (input.isAdmin) return { action: 'continue' }
  return {
    action: 'block_non_admin',
    error: 'The app is offline. Only an Admin can sign in to restore access.',
  }
}

/** After a valid OTP, decide offline gate behavior. */
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
