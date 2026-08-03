/**
 * SQLite ACL store for local-api — same schema as D1 (migrations/0001_acl.sql).
 * Provides a D1-like prepare/bind/first/all/run/batch surface.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  permission TEXT NOT NULL DEFAULT 'edit' CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (group_id, email)
);
CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email);
CREATE TABLE IF NOT EXISTS project_grants (
  cloud_key TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (cloud_key, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_project_grants_principal ON project_grants(principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_project_grants_key ON project_grants(cloud_key);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`

const SEED_SQL = `
INSERT INTO users (email, display_name, role, created_by)
VALUES ('robert.piwin@quadreal.com', 'Robert Piwin', 'admin', 'seed')
ON CONFLICT(email) DO UPDATE SET
  role = 'admin',
  display_name = COALESCE(NULLIF(excluded.display_name, ''), users.display_name);
`

export function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

export function newGroupId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export function openAclDb(dbPath) {
  const resolved =
    dbPath ||
    path.resolve(__dirname, '..', '.data', 'insp360-acl.sqlite')
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const raw = new DatabaseSync(resolved)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(SCHEMA_SQL)
  try {
    raw.exec(
      `ALTER TABLE group_members ADD COLUMN permission TEXT NOT NULL DEFAULT 'edit'`,
    )
  } catch (_) {
    /* column already present */
  }
  raw.exec(SEED_SQL)

  const db = {
    path: resolved,
    prepare(sql) {
      return {
        bind(...params) {
          const runStmt = () => raw.prepare(sql)
          return {
            first() {
              const row = runStmt().get(...params)
              return row ?? null
            },
            all() {
              return { results: runStmt().all(...params) }
            },
            run() {
              const info = runStmt().run(...params)
              return { meta: { changes: info.changes ?? 0 } }
            },
          }
        },
      }
    },
    async batch(items) {
      raw.exec('BEGIN')
      try {
        for (const item of items) {
          if (item && typeof item.run === 'function') item.run()
        }
        raw.exec('COMMIT')
      } catch (e) {
        try {
          raw.exec('ROLLBACK')
        } catch (_) {
          /* ignore */
        }
        throw e
      }
    },
  }
  return db
}

export function permRank(p) {
  if (p === 'admin') return 3
  if (p === 'edit') return 2
  if (p === 'view') return 1
  return 0
}

export function betterPerm(a, b) {
  return permRank(a) >= permRank(b) ? a : b
}

export function lesserPerm(a, b) {
  return permRank(a) <= permRank(b) ? a : b
}

/** Accept string emails or { email, permission } objects. */
export function normalizeGroupMemberList(raw) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(raw) ? raw : []) {
    let email = ''
    let permission = 'view'
    if (typeof m === 'string') {
      email = normalizeEmail(m)
      permission = 'view'
    } else if (m && typeof m === 'object') {
      email = normalizeEmail(m.email || m.principal_id)
      permission = m.permission === 'edit' ? 'edit' : 'view'
    }
    if (!email.includes('@') || seen.has(email)) continue
    seen.add(email)
    out.push({ email, permission })
  }
  return out
}

/** Groups visible to this user: all groups for admins, memberships for members. */
export async function listGroupsForUser(db, user) {
  if (!db || !user) return []
  if (user.role === 'admin') {
    const rows = await db.prepare('SELECT id, name FROM groups ORDER BY name ASC').all()
    return (rows.results || []).map((g) => ({ id: g.id, name: g.name || '' }))
  }
  const email = normalizeEmail(user.email)
  if (!email) return []
  const rows = await db
    .prepare(
      `SELECT g.id, g.name FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.email = ? COLLATE NOCASE
       ORDER BY g.name ASC`,
    )
    .bind(email)
    .all()
  return (rows.results || []).map((g) => ({ id: g.id, name: g.name || '' }))
}

export async function loadOrCreateUser(db, email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  if (!db) {
    return { email: normalized, display_name: '', role: 'admin' }
  }
  const existing = await db
    .prepare('SELECT email, display_name, role FROM users WHERE email = ? COLLATE NOCASE')
    .bind(normalized)
    .first()
  if (existing) {
    return {
      email: normalizeEmail(existing.email),
      display_name: existing.display_name || '',
      role: existing.role === 'admin' ? 'admin' : 'member',
    }
  }
  await db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_by)
       VALUES (?, '', 'member', 'auto')
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(normalized)
    .run()
  const created = await db
    .prepare('SELECT email, display_name, role FROM users WHERE email = ? COLLATE NOCASE')
    .bind(normalized)
    .first()
  return {
    email: normalizeEmail(created?.email || normalized),
    display_name: created?.display_name || '',
    role: created?.role === 'admin' ? 'admin' : 'member',
  }
}

export async function resolveTourPermission(db, user, cloudKey, sanitizeKey) {
  if (!user) return null
  if (user.role === 'admin') return 'admin'
  if (!db) return null
  const key = sanitizeKey(cloudKey)
  if (!key) return null

  const direct = await db
    .prepare(
      `SELECT permission FROM project_grants
       WHERE cloud_key = ? AND principal_type = 'user' AND principal_id = ? COLLATE NOCASE`,
    )
    .bind(key, user.email)
    .first()

  let best =
    direct?.permission === 'edit' || direct?.permission === 'view' ? direct.permission : null

  const groupRows = await db
    .prepare(
      `SELECT pg.permission AS group_permission, gm.permission AS member_permission
       FROM project_grants pg
       INNER JOIN group_members gm ON gm.group_id = pg.principal_id
       WHERE pg.cloud_key = ?
         AND pg.principal_type = 'group'
         AND gm.email = ? COLLATE NOCASE`,
    )
    .bind(key, user.email)
    .all()

  for (const row of groupRows.results || []) {
    const gPerm = row.group_permission === 'edit' || row.group_permission === 'view' ? row.group_permission : null
    if (!gPerm) continue
    const mPerm = row.member_permission === 'view' ? 'view' : 'edit'
    const effective = lesserPerm(gPerm, mPerm)
    best = best ? betterPerm(best, effective) : effective
  }
  return best
}

export async function loadUserTourPermissions(db, user) {
  const map = new Map()
  if (!user || user.role === 'admin' || !db) return map

  const direct = await db
    .prepare(
      `SELECT cloud_key, permission FROM project_grants
       WHERE principal_type = 'user' AND principal_id = ? COLLATE NOCASE`,
    )
    .bind(user.email)
    .all()
  for (const row of direct.results || []) {
    const k = row.cloud_key
    const p = row.permission
    if (p === 'view' || p === 'edit') {
      map.set(k, map.has(k) ? betterPerm(map.get(k), p) : p)
    }
  }

  const viaGroup = await db
    .prepare(
      `SELECT pg.cloud_key, pg.permission AS group_permission, gm.permission AS member_permission
       FROM project_grants pg
       INNER JOIN group_members gm ON gm.group_id = pg.principal_id
       WHERE pg.principal_type = 'group' AND gm.email = ? COLLATE NOCASE`,
    )
    .bind(user.email)
    .all()
  for (const row of viaGroup.results || []) {
    const k = row.cloud_key
    const gPerm = row.group_permission === 'edit' || row.group_permission === 'view' ? row.group_permission : null
    if (!gPerm) continue
    const mPerm = row.member_permission === 'view' ? 'view' : 'edit'
    const p = lesserPerm(gPerm, mPerm)
    map.set(k, map.has(k) ? betterPerm(map.get(k), p) : p)
  }
  return map
}

/**
 * Resolve local identity: X-Insp360-Email header, ?as=, or LOCAL_ACL_EMAIL env.
 */
export function resolveLocalEmail(req, url) {
  const header = normalizeEmail(req.headers['x-insp360-email'])
  if (header && header.includes('@')) return header
  const as = normalizeEmail(url.searchParams.get('as'))
  if (as && as.includes('@')) return as
  const envEmail = normalizeEmail(process.env.LOCAL_ACL_EMAIL || 'robert.piwin@quadreal.com')
  return envEmail
}
