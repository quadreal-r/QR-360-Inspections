/**
 * INSP 360 Worker — session-gated API over R2 bucket `insp360` + D1 ACL + static viewer assets.
 *
 * Routes:
 *   GET  /api/health
 *   POST /api/auth/request-code | verify | logout
 *   POST /api/telemetry
 *   GET  /api/me
 *   GET  /api/tours?prefix=
 *   GET  /api/tours/<key>
 *   GET  /api/tours/<key>/cover
 *   GET  /api/tours/<key>/tour
 *   PUT  /api/tours/<key>
 *   PUT  /api/tours/<key>/cover
 *   PUT  /api/tours/<key>/tour
 *   GET  /api/tours/<key>/photos                 — list blur/photo overlays
 *   PUT  /api/tours/<key>/photos/<name>          — upload one modified photo overlay
 *   GET  /api/tours/<key>/photos/<name>
 *   DELETE /api/tours/<key>/photos[/<name>]
 *   POST /api/tours/<key>/mpu                    — start resumable multipart upload
 *   PUT  /api/tours/<key>/mpu/<uploadId>/parts/n — upload one part
 *   POST /api/tours/<key>/mpu/<uploadId>/complete
 *   DELETE /api/tours/<key>/mpu/<uploadId>       — abort
 *   DELETE /api/tours/<key>                      — admin or edit permission
 *   PATCH /api/tours/<key>/status                — captureStatus skeleton|in_progress|complete
 *   /api/admin/*  (admin role only; includes POST /api/admin/notify,
 *                 GET /api/admin/activity-log, POST /api/admin/activity-log/send)
 * Cron: daily activity digest → quadreal.rpiwin@gmail.com
 */

import {
  authWallResponse,
  buildTourAssignEmail,
  handleAuthApi,
  sendResendEmail,
  verifySession,
} from './auth.js'
import {
  getActivityReport,
  handleTelemetryPost,
  recordEvent,
  sendActivityReportNow,
  sendDailyActivityReport,
} from './activity.js'
import {
  coverCompanionKey,
  extractZipImage,
  photoOverlayKey,
  photosPrefix,
  sanitizePhotoName,
  tourCompanionKey,
} from './zip-preview.js'

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB hard ceiling
const MAX_COVER_BYTES = 4 * 1024 * 1024
const MAX_TOUR_JSON_BYTES = 8 * 1024 * 1024
const MAX_PHOTO_OVERLAY_BYTES = 48 * 1024 * 1024
/** Client multipart part size hint (R2 requires ≥5 MiB for non-final parts). */
const MULTIPART_PART_SIZE = 24 * 1024 * 1024 // align with client CLOUD_MPU_PART_SIZE

async function listPhotoOverlays(bucket, tourKey) {
  const prefix = photosPrefix(tourKey)
  const listed = await bucket.list({ prefix, limit: 1000 })
  return (listed.objects || []).map((o) => ({
    name: String(o.key || '').slice(prefix.length),
    key: o.key,
    size: o.size,
    uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
  })).filter((p) => p.name && sanitizePhotoName(p.name))
}

async function deletePhotoOverlays(bucket, tourKey) {
  const prefix = photosPrefix(tourKey)
  let cursor
  do {
    const listed = await bucket.list({ prefix, limit: 1000, cursor })
    for (const o of listed.objects || []) {
      try {
        await bucket.delete(o.key)
      } catch (_) {
        /* ignore */
      }
    }
    cursor = listed.truncated ? listed.cursor : null
  } while (cursor)
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  })
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, PATCH, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie, Range, X-Capture-Status, X-Insp360-Email, X-HTTP-Method-Override',
    'Access-Control-Expose-Headers':
      'ETag, Content-Length, Content-Type, Content-Range, Accept-Ranges, X-Tour-Key, X-Cover-Source',
  }
}

/** Parse `Range: bytes=start-end` for R2 partial reads. */
function parseBytesRange(header, size) {
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return null
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(String(header || '').trim())
  if (!m) return null
  const start = Number(m[1])
  if (!Number.isInteger(start) || start < 0 || start >= n) return null
  const endRaw = m[2]
  const end =
    endRaw != null && endRaw !== ''
      ? Number(endRaw)
      : n - 1
  if (!Number.isInteger(end) || end < start) return null
  const endClamped = Math.min(end, n - 1)
  return {
    offset: start,
    length: endClamped - start + 1,
    start,
    end: endClamped,
  }
}

function withCors(response, request) {
  const headers = new Headers(response.headers)
  const c = corsHeaders(request)
  for (const [k, v] of Object.entries(c)) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function decodeKey(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function sanitizeKey(key) {
  let k = String(key || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!k || k.includes('..')) return null
  if (!/\.insp360$/i.test(k)) k += '.insp360'
  if (k.length > 512) return null
  return k
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

function newGroupId() {
  return `g_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/* ================= ACL (D1) ================= */

async function loadOrCreateUser(env, email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  if (!env.INSP360_DB) {
    // Dev without D1: treat as admin so local wrangler still works.
    return { email: normalized, display_name: '', role: 'admin' }
  }

  const existing = await env.INSP360_DB.prepare(
    'SELECT email, display_name, role FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(normalized)
    .first()
  if (existing) {
    return {
      email: normalizeEmail(existing.email),
      display_name: existing.display_name || '',
      role: existing.role === 'admin' ? 'admin' : 'member',
    }
  }

  await env.INSP360_DB.prepare(
    `INSERT INTO users (email, display_name, role, created_by)
     VALUES (?, '', 'member', 'auto')
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(normalized)
    .run()

  const created = await env.INSP360_DB.prepare(
    'SELECT email, display_name, role FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(normalized)
    .first()
  return {
    email: normalizeEmail(created?.email || normalized),
    display_name: created?.display_name || '',
    role: created?.role === 'admin' ? 'admin' : 'member',
  }
}

function permRank(p) {
  if (p === 'admin') return 3
  if (p === 'edit') return 2
  if (p === 'view') return 1
  return 0
}

function betterPerm(a, b) {
  return permRank(a) >= permRank(b) ? a : b
}

/**
 * Resolve caller's permission on a cloud tour key.
 * Tours with no grants = admin-only.
 */
async function resolveTourPermission(env, user, cloudKey) {
  if (!user) return null
  if (user.role === 'admin') return 'admin'
  if (!env.INSP360_DB) return null

  const key = sanitizeKey(cloudKey)
  if (!key) return null

  const direct = await env.INSP360_DB.prepare(
    `SELECT permission FROM project_grants
     WHERE cloud_key = ? AND principal_type = 'user' AND principal_id = ? COLLATE NOCASE`,
  )
    .bind(key, user.email)
    .first()

  let best = direct?.permission === 'edit' || direct?.permission === 'view' ? direct.permission : null

  const groupRows = await env.INSP360_DB.prepare(
    `SELECT pg.permission
     FROM project_grants pg
     INNER JOIN group_members gm ON gm.group_id = pg.principal_id
     WHERE pg.cloud_key = ?
       AND pg.principal_type = 'group'
       AND gm.email = ? COLLATE NOCASE`,
  )
    .bind(key, user.email)
    .all()

  for (const row of groupRows.results || []) {
    if (row.permission === 'edit' || row.permission === 'view') {
      best = best ? betterPerm(best, row.permission) : row.permission
    }
  }

  return best
}

async function canViewTour(env, user, cloudKey) {
  const p = await resolveTourPermission(env, user, cloudKey)
  return permRank(p) >= permRank('view')
}

async function canEditTour(env, user, cloudKey) {
  const p = await resolveTourPermission(env, user, cloudKey)
  return permRank(p) >= permRank('edit')
}

/** Same rules as PUT /api/tours/:key — edit existing, or admin/pre-granted create. */
async function assertCanPutTour(env, user, key) {
  const existing = await env.INSP360_BUCKET.head(key)
  if (existing) {
    if (!(await canEditTour(env, user, key))) {
      return { ok: false, status: 403, error: 'Forbidden — edit permission required' }
    }
    return { ok: true }
  }
  if (user.role === 'admin') return { ok: true }
  const p = await resolveTourPermission(env, user, key)
  if (p !== 'edit') {
    return { ok: false, status: 403, error: 'Forbidden — only admins can create new cloud tours' }
  }
  return { ok: true }
}

/** Capture workflow status stored on tour.json / object customMetadata. */
const CAPTURE_STATUSES = new Set(['skeleton', 'in_progress', 'complete'])
function normalizeCaptureStatus(raw, fallback = 'in_progress') {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'completed') return 'complete'
  if (CAPTURE_STATUSES.has(s)) return s
  return fallback
}

async function readCaptureStatus(env, tourKey) {
  try {
    const side = await env.INSP360_BUCKET.head(tourCompanionKey(tourKey))
    const fromSide = side?.customMetadata?.captureStatus
    if (fromSide) return normalizeCaptureStatus(fromSide)
  } catch (_) {
    /* ignore */
  }
  try {
    const main = await env.INSP360_BUCKET.head(tourKey)
    const fromMain = main?.customMetadata?.captureStatus
    if (fromMain) return normalizeCaptureStatus(fromMain)
  } catch (_) {
    /* ignore */
  }
  return 'in_progress'
}

/** Update tour.json meta.status + companion customMetadata (small object; avoids re-uploading .insp360). */
async function writeCaptureStatus(env, user, tourKey, status) {
  const st = normalizeCaptureStatus(status)
  const companion = tourCompanionKey(tourKey)
  let tour = {}
  try {
    const obj = await env.INSP360_BUCKET.get(companion)
    if (obj) {
      tour = JSON.parse(await obj.text())
      if (!tour || typeof tour !== 'object') tour = {}
    }
  } catch (_) {
    tour = {}
  }
  if (!tour.meta || typeof tour.meta !== 'object') tour.meta = {}
  tour.meta.status = st
  if (st === 'complete') {
    tour.meta.pendingPhotos = false
    tour.meta.completedAt = new Date().toISOString()
  } else if (st === 'skeleton') {
    tour.meta.pendingPhotos = true
  } else {
    delete tour.meta.completedAt
  }
  await env.INSP360_BUCKET.put(companion, JSON.stringify(tour), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      forTour: tourKey,
      captureStatus: st,
      uploadedBy: user?.email || '',
      updatedAt: new Date().toISOString(),
    },
  })
  return st
}

/** Map of cloud_key → best permission for a non-admin user */
async function loadUserTourPermissions(env, user) {
  const map = new Map()
  if (!user || user.role === 'admin' || !env.INSP360_DB) return map

  const direct = await env.INSP360_DB.prepare(
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

  const viaGroup = await env.INSP360_DB.prepare(
    `SELECT pg.cloud_key, pg.permission
     FROM project_grants pg
     INNER JOIN group_members gm ON gm.group_id = pg.principal_id
     WHERE pg.principal_type = 'group' AND gm.email = ? COLLATE NOCASE`,
  )
    .bind(user.email)
    .all()
  for (const row of viaGroup.results || []) {
    const k = row.cloud_key
    const p = row.permission
    if (p === 'view' || p === 'edit') {
      map.set(k, map.has(k) ? betterPerm(map.get(k), p) : p)
    }
  }
  return map
}

async function listTours(env, prefix) {
  const listed = await env.INSP360_BUCKET.list({
    prefix: prefix || undefined,
    limit: 1000,
  })
  const objects = listed.objects || []
  const coverKeys = new Set(
    objects.filter((o) => /\.cover\.jpe?g$/i.test(o.key)).map((o) => o.key),
  )
  const statusFromList = new Map()
  for (const o of objects) {
    const st = o.customMetadata?.captureStatus
    if (!st) continue
    if (/\.insp360$/i.test(o.key)) statusFromList.set(o.key, normalizeCaptureStatus(st))
    else if (/\.tour\.json$/i.test(o.key)) {
      statusFromList.set(o.key.replace(/\.tour\.json$/i, '.insp360'), normalizeCaptureStatus(st))
    }
  }
  const tours = objects
    .filter((o) => /\.insp360$/i.test(o.key))
    .map((o) => {
      const companion = coverCompanionKey(o.key)
      const hasCover = coverKeys.has(companion)
      return {
        key: o.key,
        size: o.size,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        etag: o.etag || null,
        hasCover,
        coverKey: hasCover ? companion : null,
        status: statusFromList.get(o.key) || null,
      }
    })
    .sort((a, b) => String(b.uploaded || '').localeCompare(String(a.uploaded || '')))
  // Fill missing status from companion/object HEAD (list often omits customMetadata)
  await Promise.all(
    tours.map(async (t) => {
      if (t.status) return
      t.status = await readCaptureStatus(env, t.key)
    }),
  )
  return tours
}

async function listToursForUser(env, user, prefix) {
  const tours = await listTours(env, prefix)
  if (user.role === 'admin') {
    return tours.map((t) => ({ ...t, permission: 'admin' }))
  }
  const perms = await loadUserTourPermissions(env, user)
  return tours
    .filter((t) => perms.has(t.key))
    .map((t) => ({ ...t, permission: perms.get(t.key) }))
}

async function readR2Range(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } })
  if (!obj) return null
  return new Uint8Array(await obj.arrayBuffer())
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([bytes]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function getTourCoverResponse(bucket, key) {
  const companion = coverCompanionKey(key)
  const side = await bucket.get(companion)
  if (side) {
    const headers = new Headers()
    headers.set('Content-Type', side.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, max-age=300')
    headers.set('X-Tour-Key', key)
    headers.set('X-Cover-Source', 'sidecar')
    if (side.size != null) headers.set('Content-Length', String(side.size))
    return new Response(side.body, { status: 200, headers })
  }

  const head = await bucket.head(key)
  if (!head) return json({ error: 'Tour not found', key }, 404)
  const extracted = await extractZipImage(
    (offset, length) => readR2Range(bucket, key, offset, length),
    head.size,
    inflateRaw,
    ['preview.jpg', 'cover.jpg'],
  )
  if (!extracted) return json({ error: 'No preview in tour', key }, 404)
  return new Response(extracted.bytes, {
    status: 200,
    headers: {
      'Content-Type': extracted.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
      'X-Tour-Key': key,
      'X-Cover-Source': 'zip:' + extracted.name,
    },
  })
}

async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') {
    return json({ error: 'Admin only' }, 403)
  }
  return null
}

/* ================= Admin routes ================= */

async function handleAdmin(request, env, user, path) {
  const denied = requireAdmin(user)
  if (denied) return denied

  const url = new URL(request.url)

  // GET /api/admin/users
  if (path === '/api/admin/users' && request.method === 'GET') {
    const rows = await env.INSP360_DB.prepare(
      `SELECT email, display_name, role, created_at, created_by
       FROM users ORDER BY role DESC, email ASC`,
    ).all()
    return json({ users: rows.results || [] })
  }

  // POST /api/admin/users — add/update
  if (path === '/api/admin/users' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const email = normalizeEmail(body?.email)
    if (!email || !email.includes('@')) return json({ error: 'Valid email required' }, 400)
    const role = body?.role === 'admin' ? 'admin' : 'member'
    const displayName = String(body?.display_name ?? body?.name ?? '').trim()
    await env.INSP360_DB.prepare(
      `INSERT INTO users (email, display_name, role, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         display_name = CASE
           WHEN excluded.display_name != '' THEN excluded.display_name
           ELSE users.display_name
         END,
         role = excluded.role`,
    )
      .bind(email, displayName, role, user.email)
      .run()
    const row = await env.INSP360_DB.prepare(
      'SELECT email, display_name, role, created_at, created_by FROM users WHERE email = ? COLLATE NOCASE',
    )
      .bind(email)
      .first()
    return json({ ok: true, user: row })
  }

  // DELETE /api/admin/users/:email
  const userDel = path.match(/^\/api\/admin\/users\/(.+)$/)
  if (userDel && request.method === 'DELETE') {
    const email = normalizeEmail(decodeKey(userDel[1]))
    if (!email) return json({ error: 'Invalid email' }, 400)
    if (email === user.email) return json({ error: 'Cannot delete yourself' }, 400)
    await env.INSP360_DB.batch([
      env.INSP360_DB.prepare('DELETE FROM group_members WHERE email = ? COLLATE NOCASE').bind(email),
      env.INSP360_DB.prepare(
        `DELETE FROM project_grants WHERE principal_type = 'user' AND principal_id = ? COLLATE NOCASE`,
      ).bind(email),
      env.INSP360_DB.prepare('DELETE FROM users WHERE email = ? COLLATE NOCASE').bind(email),
    ])
    return json({ ok: true, email })
  }

  // GET /api/admin/groups
  if (path === '/api/admin/groups' && request.method === 'GET') {
    const groups = await env.INSP360_DB.prepare(
      'SELECT id, name, created_at FROM groups ORDER BY name ASC',
    ).all()
    const members = await env.INSP360_DB.prepare(
      'SELECT group_id, email FROM group_members ORDER BY email ASC',
    ).all()
    const byGroup = new Map()
    for (const m of members.results || []) {
      if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, [])
      byGroup.get(m.group_id).push(m.email)
    }
    return json({
      groups: (groups.results || []).map((g) => ({
        ...g,
        members: byGroup.get(g.id) || [],
      })),
    })
  }

  // POST /api/admin/groups — create
  if (path === '/api/admin/groups' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const name = String(body?.name || '').trim()
    if (!name) return json({ error: 'Group name required' }, 400)
    const id = newGroupId()
    await env.INSP360_DB.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').bind(id, name).run()
    return json({ ok: true, group: { id, name, members: [] } })
  }

  // PATCH /api/admin/groups/:id — rename
  // DELETE /api/admin/groups/:id
  // PUT /api/admin/groups/:id/members
  const groupMembersMatch = path.match(/^\/api\/admin\/groups\/([^/]+)\/members$/)
  if (groupMembersMatch && request.method === 'PUT') {
    const id = decodeKey(groupMembersMatch[1])
    const exists = await env.INSP360_DB.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
    if (!exists) return json({ error: 'Group not found' }, 404)
    const body = await readJsonBody(request)
    const emails = Array.isArray(body?.members)
      ? body.members.map(normalizeEmail).filter((e) => e && e.includes('@'))
      : []
    const unique = [...new Set(emails)]
    const stmts = [env.INSP360_DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(id)]
    for (const email of unique) {
      // Ensure user row exists so grants/UI stay consistent
      stmts.push(
        env.INSP360_DB.prepare(
          `INSERT INTO users (email, display_name, role, created_by)
           VALUES (?, '', 'member', ?)
           ON CONFLICT(email) DO NOTHING`,
        ).bind(email, user.email),
      )
      stmts.push(
        env.INSP360_DB.prepare('INSERT INTO group_members (group_id, email) VALUES (?, ?)').bind(
          id,
          email,
        ),
      )
    }
    await env.INSP360_DB.batch(stmts)
    return json({ ok: true, id, members: unique })
  }

  const groupMatch = path.match(/^\/api\/admin\/groups\/([^/]+)$/)
  if (groupMatch) {
    const id = decodeKey(groupMatch[1])
    if (request.method === 'PATCH') {
      const body = await readJsonBody(request)
      const name = String(body?.name || '').trim()
      if (!name) return json({ error: 'Group name required' }, 400)
      const result = await env.INSP360_DB.prepare('UPDATE groups SET name = ? WHERE id = ?')
        .bind(name, id)
        .run()
      if (!result.meta?.changes) return json({ error: 'Group not found' }, 404)
      return json({ ok: true, group: { id, name } })
    }
    if (request.method === 'DELETE') {
      await env.INSP360_DB.batch([
        env.INSP360_DB.prepare(
          `DELETE FROM project_grants WHERE principal_type = 'group' AND principal_id = ?`,
        ).bind(id),
        env.INSP360_DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(id),
        env.INSP360_DB.prepare('DELETE FROM groups WHERE id = ?').bind(id),
      ])
      return json({ ok: true, id })
    }
  }

  // GET /api/admin/projects — R2 tours + grant summary
  if (path === '/api/admin/projects' && request.method === 'GET') {
    const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+/, '')
    if (prefix.includes('..')) return json({ error: 'Invalid prefix' }, 400)
    const tours = await listTours(env, prefix)
    const grantRows = await env.INSP360_DB.prepare(
      `SELECT cloud_key, principal_type, principal_id, permission FROM project_grants`,
    ).all()
    const byKey = new Map()
    for (const g of grantRows.results || []) {
      if (!byKey.has(g.cloud_key)) byKey.set(g.cloud_key, [])
      byKey.get(g.cloud_key).push({
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
      })
    }
    return json({
      projects: tours.map((t) => ({
        ...t,
        grants: byKey.get(t.key) || [],
      })),
    })
  }

  // PUT /api/admin/projects/:key/grants
  const grantsMatch = path.match(/^\/api\/admin\/projects\/(.+)\/grants$/)
  if (grantsMatch && request.method === 'PUT') {
    const key = sanitizeKey(decodeKey(grantsMatch[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)
    const body = await readJsonBody(request)
    const grants = Array.isArray(body?.grants) ? body.grants : []
    const cleaned = []
    for (const g of grants) {
      const principal_type = g?.principal_type === 'group' ? 'group' : 'user'
      let principal_id =
        principal_type === 'user' ? normalizeEmail(g?.principal_id) : String(g?.principal_id || '').trim()
      const permission = g?.permission === 'edit' ? 'edit' : g?.permission === 'view' ? 'view' : null
      if (!principal_id || !permission) continue
      if (principal_type === 'user' && !principal_id.includes('@')) continue
      cleaned.push({ principal_type, principal_id, permission })
    }
    // Deduplicate by principal
    const seen = new Map()
    for (const g of cleaned) {
      seen.set(`${g.principal_type}:${g.principal_id.toLowerCase()}`, g)
    }
    const finalGrants = [...seen.values()]
    const stmts = [
      env.INSP360_DB.prepare('DELETE FROM project_grants WHERE cloud_key = ?').bind(key),
    ]
    for (const g of finalGrants) {
      stmts.push(
        env.INSP360_DB.prepare(
          `INSERT INTO project_grants (cloud_key, principal_type, principal_id, permission)
           VALUES (?, ?, ?, ?)`,
        ).bind(key, g.principal_type, g.principal_id, g.permission),
      )
    }
    await env.INSP360_DB.batch(stmts)
    try {
      await recordEvent(env, {
        email: user.email,
        event_type: 'tour_grants_update',
        tour_key: key,
        meta: { grantCount: finalGrants.length, grants: finalGrants.slice(0, 20) },
      })
    } catch (_) {
      /* telemetry must not block grants save */
    }
    return json({ ok: true, key, grants: finalGrants })
  }

  // GET /api/admin/activity-log?hours=24 — last N hours digest (default 24, max 168)
  if (path === '/api/admin/activity-log' && request.method === 'GET') {
    const hours = url.searchParams.get('hours')
    const report = await getActivityReport(env, hours)
    return json(report)
  }

  // POST /api/admin/activity-log/send — email digest now to hardcoded activity-report recipient only
  if (path === '/api/admin/activity-log/send' && request.method === 'POST') {
    let hours = url.searchParams.get('hours')
    try {
      const body = await readJsonBody(request)
      if (body?.hours != null && hours == null) hours = body.hours
    } catch (_) {
      /* empty body ok */
    }
    const result = await sendActivityReportNow(env, hours)
    if (!result.ok) return json(result, 502)
    return json(result)
  }

  // POST /api/admin/notify — email selected users about a tour assignment
  if (path === '/api/admin/notify' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const rawEmails = Array.isArray(body?.emails) ? body.emails : []
    const unique = [
      ...new Set(rawEmails.map(normalizeEmail).filter((e) => e && e.includes('@'))),
    ].slice(0, 80)
    if (!unique.length) return json({ error: 'Select at least one person' }, 400)

    const tourKey = sanitizeKey(String(body?.tourKey || body?.cloud_key || '').trim())
    let tourName = String(body?.tourName || body?.tour_name || '').trim()
    if (!tourName && tourKey) tourName = tourKey.replace(/\.(insp360|zip)$/i, '')
    if (!tourName) tourName = 'a 360° tour'
    const note = String(body?.note || '').trim().slice(0, 800)
    const viewerUrl = new URL(request.url).origin + '/'

    const recipients = []
    for (const email of unique) {
      const row = await env.INSP360_DB.prepare(
        'SELECT email, display_name FROM users WHERE email = ? COLLATE NOCASE',
      )
        .bind(email)
        .first()
      if (row) recipients.push(row)
    }
    if (!recipients.length) return json({ error: 'No matching allowlisted users' }, 400)

    const sent = []
    const failed = []
    for (const row of recipients) {
      const content = buildTourAssignEmail({
        displayName: '',
        email: row.email,
        tourName,
        viewerUrl,
        note,
        assignedBy: user.email,
      })
      const result = await sendResendEmail(env, {
        to: row.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
      })
      if (result.ok) sent.push(row.email)
      else failed.push({ email: row.email, error: result.error || 'Send failed' })
    }
    return json({
      ok: failed.length === 0,
      sent,
      failed,
      tourKey: tourKey || null,
      tourName,
    })
  }

  return json({ error: 'Not found' }, 404)
}

async function handleApi(request, env) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }

  if (path === '/api/health') {
    return json({ ok: true, service: 'insp360-viewer', bucket: 'insp360' })
  }

  if (path.startsWith('/api/auth/')) {
    const authRes = await handleAuthApi(request, env, path)
    if (authRes) return authRes
    return json({ error: 'Not found' }, 404)
  }

  const auth = await verifySession(request, env)
  if (!auth.ok) {
    return json({ error: auth.error || 'Unauthorized' }, 401)
  }

  const user = await loadOrCreateUser(env, auth.email)
  if (!user) {
    return json({ error: 'Could not resolve user' }, 401)
  }

  if (path === '/api/telemetry' && request.method === 'POST') {
    return handleTelemetryPost(request, env, user)
  }

  if (path === '/api/me' && request.method === 'GET') {
    const origin = new URL(request.url).origin
    const logoutUrl = `${origin}/api/auth/logout`
    let groups = []
    try {
      if (env.INSP360_DB) {
        if (user.role === 'admin') {
          const rows = await env.INSP360_DB.prepare(
            'SELECT id, name FROM groups ORDER BY name ASC',
          ).all()
          groups = (rows.results || []).map((g) => ({ id: g.id, name: g.name || '' }))
        } else {
          const rows = await env.INSP360_DB.prepare(
            `SELECT g.id, g.name FROM groups g
             INNER JOIN group_members gm ON gm.group_id = g.id
             WHERE gm.email = ? COLLATE NOCASE
             ORDER BY g.name ASC`,
          )
            .bind(user.email)
            .all()
          groups = (rows.results || []).map((g) => ({ id: g.id, name: g.name || '' }))
        }
      }
    } catch (_) {
      groups = []
    }
    return json({
      email: user.email,
      name: user.display_name || '',
      role: user.role,
      groups,
      logoutUrl,
    })
  }

  if (path.startsWith('/api/admin')) {
    if (!env.INSP360_DB) return json({ error: 'ACL database not configured' }, 503)
    return handleAdmin(request, env, user, path)
  }

  if (path === '/api/tours' && request.method === 'GET') {
    const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+/, '')
    if (prefix.includes('..')) return json({ error: 'Invalid prefix' }, 400)
    const tours = await listToursForUser(env, user, prefix)
    return json({ tours, email: user.email, role: user.role })
  }

  // PATCH /api/tours/:key/status — capture workflow status
  // Also accept POST + X-HTTP-Method-Override: PATCH (Android HttpURLConnection).
  const statusMatch = path.match(/^\/api\/tours\/(.+)\/status$/)
  const statusOverride =
    request.method === 'POST' &&
    String(request.headers.get('X-HTTP-Method-Override') || '').toUpperCase() === 'PATCH'
  if (statusMatch && (request.method === 'PATCH' || statusOverride)) {
    const key = sanitizeKey(decodeKey(statusMatch[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)
    const head = await env.INSP360_BUCKET.head(key)
    if (!head) return json({ error: 'Tour not found', key }, 404)
    if (!(await canEditTour(env, user, key))) {
      return json({ error: 'Forbidden — edit permission required' }, 403)
    }
    let body = {}
    try {
      body = await request.json()
    } catch (_) {
      body = {}
    }
    const wanted = normalizeCaptureStatus(body?.status, '')
    if (!CAPTURE_STATUSES.has(wanted)) {
      return json({ error: 'status must be skeleton, in_progress, or complete' }, 400)
    }
    const status = await writeCaptureStatus(env, user, key, wanted)
    try {
      await recordEvent(env, {
        email: user.email,
        event_type: 'tour_status',
        tour_key: key,
        meta: { status },
      })
    } catch (_) {
      /* telemetry must not block */
    }
    return json({ ok: true, key, status })
  }

  // ---- Resumable multipart upload (R2) ----
  // POST /api/tours/:key/mpu
  const mpuCreate = path.match(/^\/api\/tours\/(.+)\/mpu$/)
  if (mpuCreate && request.method === 'POST') {
    const key = sanitizeKey(decodeKey(mpuCreate[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)
    const gate = await assertCanPutTour(env, user, key)
    if (!gate.ok) return json({ error: gate.error }, gate.status)
    let body = {}
    try {
      body = await request.json()
    } catch (_) {
      body = {}
    }
    const size = Number(body?.size || 0)
    if (size > MAX_UPLOAD_BYTES) return json({ error: 'File too large' }, 413)
    const captureStatus = normalizeCaptureStatus(body?.captureStatus || body?.status, 'in_progress')
    const upload = await env.INSP360_BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: String(body?.contentType || 'application/zip'),
      },
      customMetadata: {
        uploadedBy: user.email || '',
        uploadedAt: new Date().toISOString(),
        captureStatus,
      },
    })
    return json({
      ok: true,
      key,
      uploadId: upload.uploadId,
      partSize: MULTIPART_PART_SIZE,
    })
  }

  // PUT /api/tours/:key/mpu/:uploadId/parts/:n
  const mpuPart = path.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)\/parts\/(\d+)$/)
  if (mpuPart && request.method === 'PUT') {
    const key = sanitizeKey(decodeKey(mpuPart[1]))
    const uploadId = decodeKey(mpuPart[2])
    const partNumber = Number(mpuPart[3])
    if (!key || !uploadId) return json({ error: 'Invalid tour key or uploadId' }, 400)
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return json({ error: 'Invalid part number' }, 400)
    }
    const gate = await assertCanPutTour(env, user, key)
    if (!gate.ok) return json({ error: gate.error }, gate.status)
    if (!request.body) return json({ error: 'Empty body' }, 400)
    const len = Number(request.headers.get('Content-Length') || 0)
    if (len > MULTIPART_PART_SIZE * 2) return json({ error: 'Part too large' }, 413)
    try {
      const upload = env.INSP360_BUCKET.resumeMultipartUpload(key, uploadId)
      const t0 = Date.now()
      const part = await upload.uploadPart(partNumber, request.body)
      console.log('mpu part ok', {
        key,
        partNumber: part.partNumber,
        ms: Date.now() - t0,
        bytes: len || null,
      })
      return json({ ok: true, partNumber: part.partNumber, etag: part.etag })
    } catch (err) {
      console.error('mpu part failed', err)
      return json({ error: err?.message || 'Part upload failed' }, 400)
    }
  }

  // POST /api/tours/:key/mpu/:uploadId/complete
  const mpuComplete = path.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)\/complete$/)
  if (mpuComplete && request.method === 'POST') {
    const key = sanitizeKey(decodeKey(mpuComplete[1]))
    const uploadId = decodeKey(mpuComplete[2])
    if (!key || !uploadId) return json({ error: 'Invalid tour key or uploadId' }, 400)
    const gate = await assertCanPutTour(env, user, key)
    if (!gate.ok) return json({ error: gate.error }, gate.status)
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }
    const partsIn = Array.isArray(body?.parts) ? body.parts : []
    const parts = partsIn
      .map((p) => ({
        partNumber: Number(p?.partNumber),
        etag: String(p?.etag || ''),
      }))
      .filter((p) => Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.etag)
      .sort((a, b) => a.partNumber - b.partNumber)
    if (!parts.length) return json({ error: 'No parts to complete' }, 400)
    try {
      const upload = env.INSP360_BUCKET.resumeMultipartUpload(key, uploadId)
      const t0 = Date.now()
      await upload.complete(parts)
      console.log('mpu complete ok', {
        key,
        parts: parts.length,
        size: body?.size || null,
        ms: Date.now() - t0,
      })
      try {
        await recordEvent(env, {
          email: user.email,
          event_type: 'tour_upload',
          tour_key: key,
          meta: { size: body?.size || null, multipart: true, parts: parts.length },
        })
      } catch (_) {
        /* telemetry must not block */
      }
      return json({ ok: true, key, uploadedBy: user.email, parts: parts.length })
    } catch (err) {
      console.error('mpu complete failed', err)
      return json({ error: err?.message || 'Could not complete multipart upload' }, 400)
    }
  }

  // DELETE /api/tours/:key/mpu/:uploadId
  const mpuAbort = path.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)$/)
  if (mpuAbort && request.method === 'DELETE') {
    const key = sanitizeKey(decodeKey(mpuAbort[1]))
    const uploadId = decodeKey(mpuAbort[2])
    if (!key || !uploadId) return json({ error: 'Invalid tour key or uploadId' }, 400)
    const gate = await assertCanPutTour(env, user, key)
    if (!gate.ok) return json({ error: gate.error }, gate.status)
    try {
      const upload = env.INSP360_BUCKET.resumeMultipartUpload(key, uploadId)
      await upload.abort()
    } catch (err) {
      console.warn('mpu abort', err?.message || err)
    }
    return json({ ok: true, key, uploadId })
  }

  // GET/DELETE /api/tours/:key/photos — list or clear blur overlays
  const photosListMatch = path.match(/^\/api\/tours\/(.+)\/photos$/)
  if (photosListMatch) {
    const key = sanitizeKey(decodeKey(photosListMatch[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)
    if (request.method === 'GET') {
      if (!(await canViewTour(env, user, key))) {
        return json({ error: 'Forbidden' }, 403)
      }
      const photos = await listPhotoOverlays(env.INSP360_BUCKET, key)
      return json({ ok: true, key, photos })
    }
    if (request.method === 'DELETE') {
      if (!(await canEditTour(env, user, key))) {
        return json({ error: 'Forbidden — edit permission required' }, 403)
      }
      await deletePhotoOverlays(env.INSP360_BUCKET, key)
      return json({ ok: true, key })
    }
    return json({ error: 'Method not allowed' }, 405)
  }

  // GET/PUT/DELETE /api/tours/:key/photos/:photoName — per-photo blur overlay
  const photoOneMatch = path.match(/^\/api\/tours\/(.+)\/photos\/([^/]+)$/)
  if (photoOneMatch) {
    const key = sanitizeKey(decodeKey(photoOneMatch[1]))
    const photoName = sanitizePhotoName(decodeKey(photoOneMatch[2]))
    if (!key || !photoName) return json({ error: 'Invalid tour key or photo name' }, 400)
    const overlayKey = photoOverlayKey(key, photoName)
    if (!overlayKey) return json({ error: 'Invalid photo name' }, 400)

    if (request.method === 'GET') {
      if (!(await canViewTour(env, user, key))) {
        return json({ error: 'Forbidden' }, 403)
      }
      const obj = await env.INSP360_BUCKET.get(overlayKey)
      if (!obj) return json({ error: 'Photo overlay not found', key: overlayKey }, 404)
      const headers = new Headers()
      headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg')
      headers.set('Cache-Control', 'private, max-age=60')
      headers.set('X-Tour-Key', key)
      headers.set('X-Photo-Name', photoName)
      if (obj.size != null) headers.set('Content-Length', String(obj.size))
      return new Response(obj.body, { status: 200, headers })
    }

    if (request.method === 'PUT') {
      if (!(await canEditTour(env, user, key))) {
        return json({ error: 'Forbidden — edit permission required' }, 403)
      }
      const len = Number(request.headers.get('Content-Length') || 0)
      if (len > MAX_PHOTO_OVERLAY_BYTES) return json({ error: 'Photo too large' }, 413)
      if (!request.body) return json({ error: 'Empty body' }, 400)
      await env.INSP360_BUCKET.put(overlayKey, request.body, {
        httpMetadata: {
          contentType: request.headers.get('Content-Type') || 'image/jpeg',
        },
        customMetadata: {
          forTour: key,
          photoName,
          uploadedBy: user.email || '',
        },
      })
      try {
        await recordEvent(env, {
          email: user.email,
          event_type: 'tour_photo_save',
          tour_key: key,
          meta: { photo: photoName, size: len || null },
        })
      } catch (_) {
        /* telemetry must not block */
      }
      return json({ ok: true, key: overlayKey, tourKey: key, photo: photoName })
    }

    if (request.method === 'DELETE') {
      if (!(await canEditTour(env, user, key))) {
        return json({ error: 'Forbidden — edit permission required' }, 403)
      }
      await env.INSP360_BUCKET.delete(overlayKey)
      return json({ ok: true, key: overlayKey, tourKey: key, photo: photoName })
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  const coverMatch = path.match(/^\/api\/tours\/(.+)\/cover$/)
  if (coverMatch) {
    const key = sanitizeKey(decodeKey(coverMatch[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)

    if (request.method === 'GET') {
      if (!(await canViewTour(env, user, key))) {
        return json({ error: 'Forbidden' }, 403)
      }
      return getTourCoverResponse(env.INSP360_BUCKET, key)
    }

    if (request.method === 'PUT') {
      if (!(await canEditTour(env, user, key))) {
        return json({ error: 'Forbidden — edit permission required' }, 403)
      }
      const len = Number(request.headers.get('Content-Length') || 0)
      if (len > MAX_COVER_BYTES) return json({ error: 'Cover too large' }, 413)
      if (!request.body) return json({ error: 'Empty body' }, 400)
      const companion = coverCompanionKey(key)
      await env.INSP360_BUCKET.put(companion, request.body, {
        httpMetadata: {
          contentType: request.headers.get('Content-Type') || 'image/jpeg',
        },
        customMetadata: {
          forTour: key,
          uploadedBy: user.email || '',
        },
      })
      try {
        await recordEvent(env, {
          email: user.email,
          event_type: 'tour_cover_save',
          tour_key: key,
          meta: { size: len || null, companion },
        })
      } catch (_) {
        /* telemetry must not block cover save */
      }
      return json({ ok: true, key: companion, tourKey: key })
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  const tourJsonMatch = path.match(/^\/api\/tours\/(.+)\/tour$/)
  if (tourJsonMatch) {
    const key = sanitizeKey(decodeKey(tourJsonMatch[1]))
    if (!key) return json({ error: 'Invalid tour key' }, 400)
    const companion = tourCompanionKey(key)

    if (request.method === 'GET') {
      if (!(await canViewTour(env, user, key))) {
        return json({ error: 'Forbidden' }, 403)
      }
      const obj = await env.INSP360_BUCKET.get(companion)
      if (!obj) return json({ error: 'Tour JSON not found', key: companion }, 404)
      const headers = new Headers()
      headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/json; charset=utf-8')
      headers.set('Cache-Control', 'private, max-age=30')
      headers.set('X-Tour-Key', key)
      if (obj.size != null) headers.set('Content-Length', String(obj.size))
      return new Response(obj.body, { status: 200, headers })
    }

    if (request.method === 'PUT') {
      if (!(await canEditTour(env, user, key))) {
        return json({ error: 'Forbidden — edit permission required' }, 403)
      }
      const len = Number(request.headers.get('Content-Length') || 0)
      if (len > MAX_TOUR_JSON_BYTES) return json({ error: 'Tour JSON too large' }, 413)
      if (!request.body) return json({ error: 'Empty body' }, 400)
      const text = await request.text()
      let captureStatus = 'in_progress'
      try {
        const parsed = JSON.parse(text)
        if (parsed?.meta?.status) captureStatus = normalizeCaptureStatus(parsed.meta.status)
      } catch (_) {
        /* keep default */
      }
      await env.INSP360_BUCKET.put(companion, text, {
        httpMetadata: {
          contentType: request.headers.get('Content-Type') || 'application/json; charset=utf-8',
        },
        customMetadata: {
          forTour: key,
          uploadedBy: user.email || '',
          captureStatus,
        },
      })
      try {
        await recordEvent(env, {
          email: user.email,
          event_type: 'tour_json_save',
          tour_key: key,
          meta: { size: len || null, companion },
        })
      } catch (_) {
        /* telemetry must not block tour.json save */
      }
      return json({ ok: true, key: companion, tourKey: key })
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  const m = path.match(/^\/api\/tours\/(.+)$/)
  if (!m) return json({ error: 'Not found' }, 404)

  const key = sanitizeKey(decodeKey(m[1]))
  if (!key) return json({ error: 'Invalid tour key' }, 400)

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!(await canViewTour(env, user, key))) {
      return json({ error: 'Forbidden' }, 403)
    }
    const head = await env.INSP360_BUCKET.head(key)
    if (!head) return json({ error: 'Tour not found', key }, 404)
    const size = Number(head.size) || 0
    const contentType = head.httpMetadata?.contentType || 'application/zip'
    const range = parseBytesRange(request.headers.get('Range'), size)

    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Content-Disposition', `inline; filename="${key.split('/').pop()}"`)
    headers.set('Cache-Control', 'private, max-age=60')
    headers.set('Accept-Ranges', 'bytes')
    headers.set('X-Tour-Key', key)
    if (head.httpEtag) headers.set('ETag', head.httpEtag)

    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(size))
      return new Response(null, { status: 200, headers })
    }

    if (range) {
      const obj = await env.INSP360_BUCKET.get(key, {
        range: { offset: range.offset, length: range.length },
      })
      if (!obj) return json({ error: 'Tour not found', key }, 404)
      headers.set('Content-Length', String(range.length))
      headers.set(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${size}`,
      )
      return new Response(obj.body, { status: 206, headers })
    }

    const obj = await env.INSP360_BUCKET.get(key)
    if (!obj) return json({ error: 'Tour not found', key }, 404)
    if (obj.size != null) headers.set('Content-Length', String(obj.size))
    else if (size) headers.set('Content-Length', String(size))
    return new Response(obj.body, { status: 200, headers })
  }

  if (request.method === 'PUT') {
    // New upload: admin always; non-admin needs edit on existing key, or may create only if they
    // already have edit grant (or are admin). Tours with no grants stay admin-only — so members
    // cannot create brand-new keys unless granted edit on that exact key first (admin assigns).
    // Exception: if the object already exists, require edit; if it does not exist, only admin
    // may create (safe default). Members with edit on a key can overwrite.
    const gate = await assertCanPutTour(env, user, key)
    if (!gate.ok) return json({ error: gate.error }, gate.status)
    const len = Number(request.headers.get('Content-Length') || 0)
    if (len > MAX_UPLOAD_BYTES) return json({ error: 'File too large' }, 413)
    if (!request.body) return json({ error: 'Empty body' }, 400)
    const captureStatus = normalizeCaptureStatus(
      request.headers.get('X-Capture-Status') || 'in_progress',
    )
    await env.INSP360_BUCKET.put(key, request.body, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') || 'application/zip',
      },
      customMetadata: {
        uploadedBy: user.email || '',
        uploadedAt: new Date().toISOString(),
        captureStatus,
      },
    })
    try {
      await recordEvent(env, {
        email: user.email,
        event_type: 'tour_upload',
        tour_key: key,
        meta: { size: len || null, status: captureStatus },
      })
    } catch (_) {
      /* telemetry must not block upload */
    }
    return json({ ok: true, key, uploadedBy: user.email, status: captureStatus })
  }

  if (request.method === 'DELETE') {
    const mayDelete = user?.role === 'admin' || (await canEditTour(env, user, key))
    if (!mayDelete) {
      return json({ error: 'Forbidden — edit permission required' }, 403)
    }
    await env.INSP360_BUCKET.delete(key)
    try {
      await env.INSP360_BUCKET.delete(coverCompanionKey(key))
    } catch (_) {
      /* ignore */
    }
    try {
      await env.INSP360_BUCKET.delete(tourCompanionKey(key))
    } catch (_) {
      /* ignore */
    }
    try {
      await deletePhotoOverlays(env.INSP360_BUCKET, key)
    } catch (_) {
      /* ignore */
    }
    try {
      if (env.INSP360_DB) {
        await env.INSP360_DB.prepare('DELETE FROM project_grants WHERE cloud_key = ?').bind(key).run()
      }
    } catch (_) {
      /* grants cleanup best-effort */
    }
    try {
      await recordEvent(env, {
        email: user.email,
        event_type: 'tour_delete',
        tour_key: key,
      })
    } catch (_) {
      /* telemetry must not block delete */
    }
    return json({ ok: true, key })
  }

  return json({ error: 'Method not allowed' }, 405)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/api/')) {
        return withCors(await handleApi(request, env), request)
      }

      // Brand assets must stay public so the login wall can load its background.
      const isPublicBrand = url.pathname.startsWith('/brand/')

      // Session cookie gate for viewer HTML/assets. Unauthenticated → QuadReal login wall.
      const auth = await verifySession(request, env)
      if (!auth.ok) {
        if (isPublicBrand && env.ASSETS) {
          return env.ASSETS.fetch(request)
        }
        return authWallResponse(request, auth)
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request)
      }
      return json({ error: 'No assets binding' }, 500)
    } catch (err) {
      console.error(err)
      return withCors(json({ error: err?.message || 'Server error' }, 500), request)
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sendDailyActivityReport(env).catch((err) => {
        console.error('scheduled activity report failed', err?.message || err)
      }),
    )
  },
}
