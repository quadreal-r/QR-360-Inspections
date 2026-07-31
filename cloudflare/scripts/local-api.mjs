/**
 * Local INSP 360 API — same /api/tours + /api/me + /api/admin contract as the Worker,
 * backed by R2 S3 keys + local SQLite ACL (mirrors D1 insp360-acl).
 *
 * Identity (no Resend OTP on localhost — bypass session wall):
 *   Header X-Insp360-Email, query ?as=, or LOCAL_ACL_EMAIL (default robert.piwin@quadreal.com)
 *   POST /api/auth/* stubs exist for parity; no email is sent.
 *
 *   npm run local-api
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { inflateRaw as zlibInflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import {
  coverCompanionKey,
  extractZipImage,
  photoOverlayKey,
  photosPrefix,
  sanitizePhotoName,
  tourCompanionKey,
} from '../src/zip-preview.js'
import {
  openAclDb,
  normalizeEmail,
  newGroupId,
  loadOrCreateUser,
  listGroupsForUser,
  resolveTourPermission,
  loadUserTourPermissions,
  permRank,
  normalizeGroupMemberList,
  resolveLocalEmail,
} from '../src/acl-sqlite.js'

const inflateRawAsync = promisify(zlibInflateRaw)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')
const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || '127.0.0.1'
/** Match Worker/client MPU part size (24 MiB). */
const MULTIPART_PART_SIZE = 24 * 1024 * 1024
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  const text = fs.readFileSync(filePath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

const envCandidates = [
  process.env.INSP360_ENV_FILE,
  path.resolve(root, '..', '..', 'QR-East_Industrial_Database', '.env.local'),
  path.resolve(root, '..', 'QR-East_Industrial_Database', '.env.local'),
  path.resolve(root, '.env.local'),
].filter(Boolean)

for (const p of envCandidates) loadEnvFile(p)

const accountId = process.env.INSP360_R2_ACCOUNT_ID?.trim()
const accessKeyId = process.env.INSP360_R2_ACCESS_KEY_ID?.trim()
const secretAccessKey = process.env.INSP360_R2_SECRET_ACCESS_KEY?.trim()
const bucket = process.env.INSP360_R2_BUCKET_NAME?.trim() || 'insp360'

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing INSP360_R2_* credentials.')
  console.error('Expected in:', envCandidates.join(' or '))
  process.exit(1)
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
})

const aclDb = openAclDb(process.env.LOCAL_ACL_DB || path.join(root, '.data', 'insp360-acl.sqlite'))

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, PATCH, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Cf-Access-Jwt-Assertion, X-Insp360-Email, Range, X-Capture-Status, X-HTTP-Method-Override',
  'Access-Control-Expose-Headers':
    'ETag, Content-Length, Content-Type, Content-Range, Accept-Ranges, X-Tour-Key',
}

function sanitizeKey(raw) {
  let k = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  try {
    k = decodeURIComponent(k)
  } catch {
    /* keep */
  }
  if (!k || k.includes('..')) return null
  if (!/\.(insp360|360skeleton)$/i.test(k)) k += '.insp360'
  if (k.length > 512) return null
  return k
}

function decodeKey(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function json(res, data, status = 200, extra = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    ...extra,
  })
  res.end(body)
}

function cors(res) {
  res.writeHead(204, {
    ...CORS_HEADERS,
    'Access-Control-Max-Age': '86400',
  })
  res.end()
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  if (!buf.length) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

async function listAllObjects(prefix) {
  const objects = []
  let token
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      }),
    )
    for (const o of page.Contents || []) {
      if (o.Key) objects.push(o)
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return objects
}

async function listTours(prefix) {
  const objects = await listAllObjects(prefix)
  const coverKeys = new Set(
    objects.filter((o) => /\.cover\.jpe?g$/i.test(o.Key)).map((o) => o.Key),
  )
  const tours = objects
    .filter((o) => /\.(insp360|360skeleton)$/i.test(o.Key))
    .map((o) => {
      const companion = coverCompanionKey(o.Key)
      const hasCover = coverKeys.has(companion)
      return {
        key: o.Key,
        size: o.Size || 0,
        uploaded: o.LastModified ? new Date(o.LastModified).toISOString() : null,
        etag: o.ETag || null,
        hasCover,
        coverKey: hasCover ? companion : null,
        status: /\.360skeleton$/i.test(o.Key) ? 'skeleton' : null,
      }
    })
  tours.sort((a, b) => String(b.uploaded || '').localeCompare(String(a.uploaded || '')))
  await Promise.all(
    tours.map(async (t) => {
      if (t.status) return
      t.status = await readCaptureStatus(t.key)
    }),
  )
  return tours
}

const CAPTURE_STATUSES = new Set(['skeleton', 'in_progress', 'complete'])
function normalizeCaptureStatus(raw, fallback = 'in_progress') {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'completed') return 'complete'
  if (CAPTURE_STATUSES.has(s)) return s
  return fallback
}

async function readCaptureStatus(tourKey) {
  try {
    const side = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: tourCompanionKey(tourKey) }),
    )
    const meta = side.Metadata || {}
    const fromSide = meta.capturestatus || meta.captureStatus
    if (fromSide) return normalizeCaptureStatus(fromSide)
  } catch (_) {
    /* ignore */
  }
  try {
    const main = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: tourKey }))
    const meta = main.Metadata || {}
    const fromMain = meta.capturestatus || meta.captureStatus
    if (fromMain) return normalizeCaptureStatus(fromMain)
  } catch (_) {
    /* ignore */
  }
  return 'in_progress'
}

async function writeCaptureStatus(user, tourKey, status) {
  const st = normalizeCaptureStatus(status)
  const companion = tourCompanionKey(tourKey)
  let tour = {}
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: companion }))
    const chunks = []
    for await (const c of obj.Body) chunks.push(c)
    tour = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!tour || typeof tour !== 'object') tour = {}
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
  const body = Buffer.from(JSON.stringify(tour), 'utf8')
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: companion,
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      Metadata: {
        fortour: tourKey,
        capturestatus: st,
        uploadedby: String(user?.email || ''),
        updatedat: new Date().toISOString(),
      },
    }),
  )
  return st
}

async function listToursForUser(user, prefix) {
  const tours = await listTours(prefix)
  if (user.role === 'admin') {
    return tours.map((t) => ({ ...t, permission: 'admin' }))
  }
  const perms = await loadUserTourPermissions(aclDb, user)
  return tours
    .filter((t) => perms.has(t.key))
    .map((t) => ({ ...t, permission: perms.get(t.key) }))
}

async function canView(user, key) {
  const p = await resolveTourPermission(aclDb, user, key, sanitizeKey)
  return permRank(p) >= permRank('view')
}

async function canEdit(user, key) {
  const p = await resolveTourPermission(aclDb, user, key, sanitizeKey)
  return permRank(p) >= permRank('edit')
}

async function ensureUserEditGrant(user, key) {
  if (!aclDb || !user?.email || !key) return
  const email = normalizeEmail(user.email)
  if (!email) return
  try {
    await aclDb
      .prepare(
        `INSERT INTO project_grants (cloud_key, principal_type, principal_id, permission)
         VALUES (?, 'user', ?, 'edit')
         ON CONFLICT(cloud_key, principal_type, principal_id) DO UPDATE SET permission = 'edit'`,
      )
      .bind(key, email)
      .run()
  } catch (e) {
    console.warn('ensureUserEditGrant failed', key, e)
  }
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (err) {
    const st = err?.$metadata?.httpStatusCode
    if (st === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false
    throw err
  }
}

/** Same create/edit rules as the Worker assertCanPutTour. */
async function assertCanPutTour(user, key) {
  const hasMain = await objectExists(key)
  const hasCompanion = hasMain ? false : await objectExists(tourCompanionKey(key))
  if (hasMain || hasCompanion) {
    if (!(await canEdit(user, key))) {
      return { ok: false, status: 403, error: 'Forbidden — edit permission required' }
    }
    return { ok: true, created: false }
  }
  if (!user?.email) return { ok: false, status: 401, error: 'Sign in required' }
  return { ok: true, created: true }
}

async function readS3Range(key, offset, length) {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${offset + length - 1}`,
    }),
  )
  const chunks = []
  for await (const c of obj.Body) chunks.push(c)
  return new Uint8Array(Buffer.concat(chunks))
}

async function getTourCover(key) {
  const companion = coverCompanionKey(key)
  try {
    const side = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: companion }))
    const chunks = []
    for await (const c of side.Body) chunks.push(c)
    return {
      buf: Buffer.concat(chunks),
      contentType: side.ContentType || 'image/jpeg',
      source: 'sidecar',
    }
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode
    if (status && status !== 404) throw err
  }

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  const extracted = await extractZipImage(
    (offset, length) => readS3Range(key, offset, length),
    head.ContentLength || 0,
    async (bytes) => new Uint8Array(await inflateRawAsync(Buffer.from(bytes))),
    ['preview.jpg', 'cover.jpg'],
  )
  if (!extracted) return null
  return {
    buf: Buffer.from(extracted.bytes),
    contentType: extracted.contentType || 'image/jpeg',
    source: 'zip:' + extracted.name,
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0] || '/')
  if (rel === '/') rel = '/index.html'
  const filePath = path.normalize(path.join(publicDir, rel.replace(/^\/+/, '')))
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const index = path.join(publicDir, 'index.html')
    if (!fs.existsSync(index)) {
      json(res, { error: 'Viewer not synced. Run npm run sync-viewer first.' }, 404)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    fs.createReadStream(index).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Type': contentType(filePath) })
  fs.createReadStream(filePath).pipe(res)
}

async function handleAdmin(req, res, user, pathname, url) {
  if (user.role !== 'admin') return json(res, { error: 'Admin only' }, 403)

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const rows = await aclDb
      .prepare(
        `SELECT email, display_name, role, created_at, created_by
         FROM users ORDER BY role DESC, email ASC`,
      )
      .bind()
      .all()
    return json(res, { users: rows.results || [] })
  }

  if (pathname === '/api/admin/users' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const email = normalizeEmail(body?.email)
    if (!email || !email.includes('@')) return json(res, { error: 'Valid email required' }, 400)
    const role = body?.role === 'admin' ? 'admin' : 'member'
    const displayName = String(body?.display_name ?? body?.name ?? '').trim()
    await aclDb
      .prepare(
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
    if (role === 'admin') {
      try {
        await aclDb
          .prepare(`UPDATE group_members SET permission = 'edit' WHERE email = ? COLLATE NOCASE`)
          .bind(email)
          .run()
      } catch (_) {
        /* ignore */
      }
    }
    const row = await aclDb
      .prepare(
        'SELECT email, display_name, role, created_at, created_by FROM users WHERE email = ? COLLATE NOCASE',
      )
      .bind(email)
      .first()
    return json(res, { ok: true, user: row })
  }

  const userDel = pathname.match(/^\/api\/admin\/users\/(.+)$/)
  if (userDel && req.method === 'DELETE') {
    const email = normalizeEmail(decodeKey(userDel[1]))
    if (!email) return json(res, { error: 'Invalid email' }, 400)
    if (email === user.email) return json(res, { error: 'Cannot delete yourself' }, 400)
    await aclDb.batch([
      aclDb.prepare('DELETE FROM group_members WHERE email = ? COLLATE NOCASE').bind(email),
      aclDb
        .prepare(
          `DELETE FROM project_grants WHERE principal_type = 'user' AND principal_id = ? COLLATE NOCASE`,
        )
        .bind(email),
      aclDb.prepare('DELETE FROM users WHERE email = ? COLLATE NOCASE').bind(email),
    ])
    return json(res, { ok: true, email })
  }

  if (pathname === '/api/admin/groups' && req.method === 'GET') {
    const groups = await aclDb
      .prepare('SELECT id, name, created_at FROM groups ORDER BY name ASC')
      .bind()
      .all()
    const members = await aclDb
      .prepare('SELECT group_id, email, permission FROM group_members ORDER BY email ASC')
      .bind()
      .all()
    const byGroup = new Map()
    for (const m of members.results || []) {
      if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, [])
      byGroup.get(m.group_id).push({
        email: m.email,
        permission: m.permission === 'view' ? 'view' : 'edit',
      })
    }
    return json(res, {
      groups: (groups.results || []).map((g) => ({
        ...g,
        members: byGroup.get(g.id) || [],
      })),
    })
  }

  if (pathname === '/api/admin/groups' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const name = String(body?.name || '').trim()
    if (!name) return json(res, { error: 'Group name required' }, 400)
    const id = newGroupId()
    await aclDb.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').bind(id, name).run()
    return json(res, { ok: true, group: { id, name, members: [] } })
  }

  const groupMembersMatch = pathname.match(/^\/api\/admin\/groups\/([^/]+)\/members$/)
  if (groupMembersMatch && req.method === 'PUT') {
    const id = decodeKey(groupMembersMatch[1])
    const exists = await aclDb.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
    if (!exists) return json(res, { error: 'Group not found' }, 404)
    const body = await readJsonBody(req)
    const unique = normalizeGroupMemberList(body?.members)
    const adminRows = await aclDb.prepare(`SELECT email FROM users WHERE role = 'admin'`).all()
    const adminEmails = new Set(
      (adminRows.results || []).map((r) => normalizeEmail(r.email)).filter(Boolean),
    )
    const withAdminEdit = unique.map((m) =>
      adminEmails.has(m.email) ? { email: m.email, permission: 'edit' } : m,
    )
    const stmts = [aclDb.prepare('DELETE FROM group_members WHERE group_id = ?').bind(id)]
    for (const { email, permission } of withAdminEdit) {
      stmts.push(
        aclDb
          .prepare(
            `INSERT INTO users (email, display_name, role, created_by)
             VALUES (?, '', 'member', ?)
             ON CONFLICT(email) DO NOTHING`,
          )
          .bind(email, user.email),
      )
      stmts.push(
        aclDb
          .prepare('INSERT INTO group_members (group_id, email, permission) VALUES (?, ?, ?)')
          .bind(id, email, permission),
      )
    }
    await aclDb.batch(stmts)
    return json(res, { ok: true, id, members: withAdminEdit })
  }

  const groupMatch = pathname.match(/^\/api\/admin\/groups\/([^/]+)$/)
  if (groupMatch) {
    const id = decodeKey(groupMatch[1])
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      const name = String(body?.name || '').trim()
      if (!name) return json(res, { error: 'Group name required' }, 400)
      const result = await aclDb
        .prepare('UPDATE groups SET name = ? WHERE id = ?')
        .bind(name, id)
        .run()
      if (!result.meta?.changes) return json(res, { error: 'Group not found' }, 404)
      return json(res, { ok: true, group: { id, name } })
    }
    if (req.method === 'DELETE') {
      await aclDb.batch([
        aclDb
          .prepare(`DELETE FROM project_grants WHERE principal_type = 'group' AND principal_id = ?`)
          .bind(id),
        aclDb.prepare('DELETE FROM group_members WHERE group_id = ?').bind(id),
        aclDb.prepare('DELETE FROM groups WHERE id = ?').bind(id),
      ])
      return json(res, { ok: true, id })
    }
  }

  if (pathname === '/api/admin/projects' && req.method === 'GET') {
    const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+/, '')
    if (prefix.includes('..')) return json(res, { error: 'Invalid prefix' }, 400)
    const tours = await listTours(prefix)
    const grantRows = await aclDb
      .prepare(
        `SELECT cloud_key, principal_type, principal_id, permission FROM project_grants`,
      )
      .bind()
      .all()
    const byKey = new Map()
    for (const g of grantRows.results || []) {
      if (!byKey.has(g.cloud_key)) byKey.set(g.cloud_key, [])
      byKey.get(g.cloud_key).push({
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
      })
    }
    return json(res, {
      projects: tours.map((t) => ({
        ...t,
        grants: byKey.get(t.key) || [],
      })),
    })
  }

  const groupToursMatch = pathname.match(/^\/api\/admin\/groups\/([^/]+)\/tours$/)
  if (groupToursMatch && req.method === 'PUT') {
    const id = decodeKey(groupToursMatch[1])
    const exists = await aclDb.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()
    if (!exists) return json(res, { error: 'Group not found' }, 404)
    const body = await readJsonBody(req)
    const raw = Array.isArray(body?.tours) ? body.tours : []
    const cleaned = []
    const seen = new Set()
    for (const t of raw) {
      const key = sanitizeKey(String(t?.key || t?.cloud_key || '').trim())
      if (!key || seen.has(key)) continue
      seen.add(key)
      cleaned.push({
        key,
        permission: t?.permission === 'edit' ? 'edit' : 'view',
      })
    }
    const stmts = [
      aclDb
        .prepare(`DELETE FROM project_grants WHERE principal_type = 'group' AND principal_id = ?`)
        .bind(id),
    ]
    for (const t of cleaned) {
      stmts.push(
        aclDb
          .prepare(
            `INSERT INTO project_grants (cloud_key, principal_type, principal_id, permission)
             VALUES (?, 'group', ?, ?)`,
          )
          .bind(t.key, id, t.permission),
      )
    }
    await aclDb.batch(stmts)
    return json(res, { ok: true, id, tours: cleaned })
  }

  return json(res, { error: 'Not found' }, 404)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') return cors(res)

    if (pathname === '/api/health') {
      return json(res, {
        ok: true,
        service: 'insp360-local-api',
        bucket,
        mode: 's3',
        acl: true,
        aclDb: aclDb.path,
      })
    }

    // Auth stubs (production uses Resend OTP + session cookie; local uses ?as= bypass).
    if (pathname === '/api/auth/request-code' && req.method === 'POST') {
      const body = (await readJsonBody(req)) || {}
      const email = normalizeEmail(body.email || resolveLocalEmail(req, url))
      return json(res, { ok: true, email, local: true, hint: 'Local API skips Resend; use ?as=email' })
    }
    if (pathname === '/api/auth/verify' && req.method === 'POST') {
      const body = (await readJsonBody(req)) || {}
      const email = normalizeEmail(body.email || resolveLocalEmail(req, url))
      return json(res, { ok: true, email, local: true })
    }
    if (pathname === '/api/auth/logout' && (req.method === 'POST' || req.method === 'GET')) {
      return json(res, { ok: true, local: true })
    }

    // Resolve local user for all authenticated API routes
    const needUser =
      pathname.startsWith('/api/tours') ||
      pathname === '/api/me' ||
      pathname.startsWith('/api/admin')
    let user = null
    if (needUser) {
      const email = resolveLocalEmail(req, url)
      user = await loadOrCreateUser(aclDb, email)
      if (!user) return json(res, { error: 'Could not resolve user' }, 401)
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      let groups = []
      try {
        groups = await listGroupsForUser(aclDb, user)
      } catch (_) {
        groups = []
      }
      return json(res, {
        email: user.email,
        name: user.display_name || '',
        role: user.role,
        groups,
        mode: 'local-acl',
        logoutUrl: `http://${HOST}:${PORT}/api/auth/logout`,
      })
    }

    if (pathname.startsWith('/api/admin')) {
      return handleAdmin(req, res, user, pathname, url)
    }

    if (pathname === '/api/tours' && req.method === 'GET') {
      const prefix = (url.searchParams.get('prefix') || '').replace(/^\/+/, '')
      if (prefix.includes('..')) return json(res, { error: 'Invalid prefix' }, 400)
      const tours = await listToursForUser(user, prefix)
      return json(res, { tours, email: user.email, role: user.role })
    }

    const statusMatch = pathname.match(/^\/api\/tours\/(.+)\/status$/)
    const statusOverride =
      req.method === 'POST' &&
      String(req.headers['x-http-method-override'] || '').toUpperCase() === 'PATCH'
    if (statusMatch && (req.method === 'PATCH' || statusOverride)) {
      const key = sanitizeKey(statusMatch[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      } catch (err) {
        const st = err?.$metadata?.httpStatusCode
        if (st === 404) return json(res, { error: 'Tour not found', key }, 404)
        throw err
      }
      if (!(await canEdit(user, key))) {
        return json(res, { error: 'Forbidden — edit permission required' }, 403)
      }
      const body = (await readJsonBody(req)) || {}
      const wanted = normalizeCaptureStatus(body?.status, '')
      if (!CAPTURE_STATUSES.has(wanted)) {
        return json(res, { error: 'status must be skeleton, in_progress, or complete' }, 400)
      }
      const status = await writeCaptureStatus(user, key, wanted)
      return json(res, { ok: true, key, status })
    }

    const photosListMatch = pathname.match(/^\/api\/tours\/(.+)\/photos$/)
    if (photosListMatch) {
      const key = sanitizeKey(photosListMatch[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)
      if (req.method === 'GET') {
        if (!(await canView(user, key))) return json(res, { error: 'Forbidden' }, 403)
        const prefix = photosPrefix(key)
        const listed = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }),
        )
        const photos = (listed.Contents || [])
          .map((o) => ({
            name: String(o.Key || '').slice(prefix.length),
            key: o.Key,
            size: o.Size,
            uploaded: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          }))
          .filter((p) => p.name && sanitizePhotoName(p.name))
        return json(res, { ok: true, key, photos })
      }
      if (req.method === 'DELETE') {
        if (!(await canEdit(user, key))) {
          return json(res, { error: 'Forbidden — edit permission required' }, 403)
        }
        const prefix = photosPrefix(key)
        const listed = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }),
        )
        for (const o of listed.Contents || []) {
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }))
          } catch (_) {
            /* ignore */
          }
        }
        return json(res, { ok: true, key })
      }
      return json(res, { error: 'Method not allowed' }, 405)
    }

    const photoOneMatch = pathname.match(/^\/api\/tours\/(.+)\/photos\/([^/]+)$/)
    if (photoOneMatch) {
      const key = sanitizeKey(photoOneMatch[1])
      const photoName = sanitizePhotoName(decodeURIComponent(photoOneMatch[2]))
      if (!key || !photoName) return json(res, { error: 'Invalid tour key or photo name' }, 400)
      const overlayKey = photoOverlayKey(key, photoName)
      if (!overlayKey) return json(res, { error: 'Invalid photo name' }, 400)

      if (req.method === 'GET') {
        if (!(await canView(user, key))) return json(res, { error: 'Forbidden' }, 403)
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: overlayKey }))
          const chunks = []
          for await (const c of obj.Body) chunks.push(c)
          const buf = Buffer.concat(chunks)
          res.writeHead(200, {
            'Content-Type': obj.ContentType || 'image/jpeg',
            'Content-Length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
            'X-Tour-Key': key,
            'X-Photo-Name': photoName,
            ...CORS_HEADERS,
          })
          res.end(buf)
        } catch (err) {
          if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') {
            return json(res, { error: 'Photo overlay not found', key: overlayKey }, 404)
          }
          throw err
        }
        return
      }

      if (req.method === 'PUT') {
        if (!(await canEdit(user, key))) {
          return json(res, { error: 'Forbidden — edit permission required' }, 403)
        }
        const body = await readBody(req)
        if (!body.length) return json(res, { error: 'Empty body' }, 400)
        if (body.length > 48 * 1024 * 1024) return json(res, { error: 'Photo too large' }, 413)
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: overlayKey,
            Body: body,
            ContentType: req.headers['content-type'] || 'image/jpeg',
          }),
        )
        return json(res, { ok: true, key: overlayKey, tourKey: key, photo: photoName })
      }

      if (req.method === 'DELETE') {
        if (!(await canEdit(user, key))) {
          return json(res, { error: 'Forbidden — edit permission required' }, 403)
        }
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: overlayKey }))
        } catch (_) {
          /* ignore */
        }
        return json(res, { ok: true, key: overlayKey, tourKey: key, photo: photoName })
      }

      return json(res, { error: 'Method not allowed' }, 405)
    }

    const coverMatch = pathname.match(/^\/api\/tours\/(.+)\/cover$/)
    if (coverMatch) {
      const key = sanitizeKey(coverMatch[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)

      if (req.method === 'GET') {
        if (!(await canView(user, key))) return json(res, { error: 'Forbidden' }, 403)
        const cover = await getTourCover(key)
        if (!cover) return json(res, { error: 'No preview in tour', key }, 404)
        res.writeHead(200, {
          'Content-Type': cover.contentType,
          'Content-Length': String(cover.buf.length),
          'Cache-Control': 'private, max-age=300',
          'X-Tour-Key': key,
          'X-Cover-Source': cover.source,
          ...CORS_HEADERS,
        })
        res.end(cover.buf)
        return
      }

      if (req.method === 'PUT') {
        if (!(await canEdit(user, key))) {
          return json(res, { error: 'Forbidden — edit permission required' }, 403)
        }
        const body = await readBody(req)
        if (!body.length) return json(res, { error: 'Empty body' }, 400)
        const companion = coverCompanionKey(key)
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: companion,
            Body: body,
            ContentType: req.headers['content-type'] || 'image/jpeg',
          }),
        )
        return json(res, { ok: true, key: companion, tourKey: key })
      }

      return json(res, { error: 'Method not allowed' }, 405)
    }

    const tourJsonMatch = pathname.match(/^\/api\/tours\/(.+)\/tour$/)
    if (tourJsonMatch) {
      const key = sanitizeKey(tourJsonMatch[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)
      const companion = tourCompanionKey(key)

      if (req.method === 'GET') {
        if (!(await canView(user, key))) return json(res, { error: 'Forbidden' }, 403)
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: companion }))
          const chunks = []
          for await (const c of obj.Body) chunks.push(c)
          const buf = Buffer.concat(chunks)
          res.writeHead(200, {
            'Content-Type': obj.ContentType || 'application/json; charset=utf-8',
            'Content-Length': String(buf.length),
            'Cache-Control': 'private, max-age=30',
            'X-Tour-Key': key,
            ...CORS_HEADERS,
          })
          res.end(buf)
        } catch (err) {
          if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') {
            return json(res, { error: 'Tour JSON not found', key: companion }, 404)
          }
          throw err
        }
        return
      }

      if (req.method === 'PUT') {
        const gate = await assertCanPutTour(user, key)
        if (!gate.ok) return json(res, { error: gate.error }, gate.status)
        const body = await readBody(req)
        if (!body.length) return json(res, { error: 'Empty body' }, 400)
        if (body.length > 8 * 1024 * 1024) return json(res, { error: 'Tour JSON too large' }, 413)
        let captureStatus = 'in_progress'
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          if (parsed?.meta?.status) captureStatus = normalizeCaptureStatus(parsed.meta.status)
        } catch (_) {
          /* keep default */
        }
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: companion,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/json; charset=utf-8',
            Metadata: {
              fortour: key,
              uploadedby: String(user.email || ''),
              capturestatus: captureStatus,
            },
          }),
        )
        if (gate.created) {
          try {
            await ensureUserEditGrant(user, key)
          } catch (_) {
            /* best-effort */
          }
        }
        return json(res, { ok: true, key: companion, tourKey: key, status: captureStatus })
      }

      return json(res, { error: 'Method not allowed' }, 405)
    }

    // ---- Resumable multipart upload (R2 S3 API) — same contract as the Worker ----
    // Avoids buffering a full 200MB+ tour in one PutObject (the long "awaiting ACK" hang).
    const mpuCreate = pathname.match(/^\/api\/tours\/(.+)\/mpu$/)
    if (mpuCreate && req.method === 'POST') {
      const key = sanitizeKey(mpuCreate[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)
      const gate = await assertCanPutTour(user, key)
      if (!gate.ok) return json(res, { error: gate.error }, gate.status)
      const body = (await readJsonBody(req)) || {}
      const size = Number(body?.size || 0)
      if (size > MAX_UPLOAD_BYTES) return json(res, { error: 'File too large' }, 413)
      const t0 = Date.now()
      const created = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: String(body?.contentType || 'application/zip'),
          Metadata: {
            uploadedby: String(user.email || ''),
            uploadedat: new Date().toISOString(),
            capturestatus: normalizeCaptureStatus(body?.captureStatus || body?.status, 'in_progress'),
          },
        }),
      )
      if (!created.UploadId) return json(res, { error: 'No uploadId from R2' }, 500)
      console.log('mpu create ok', { key, ms: Date.now() - t0, size: size || null })
      return json(res, {
        ok: true,
        uploadId: created.UploadId,
        key,
        partSize: MULTIPART_PART_SIZE,
      })
    }

    const mpuPart = pathname.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)\/parts\/(\d+)$/)
    if (mpuPart && req.method === 'PUT') {
      const key = sanitizeKey(mpuPart[1])
      const uploadId = decodeKey(mpuPart[2])
      const partNumber = Number(mpuPart[3])
      if (!key || !uploadId) return json(res, { error: 'Invalid tour key or uploadId' }, 400)
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return json(res, { error: 'Invalid part number' }, 400)
      }
      const gate = await assertCanPutTour(user, key)
      if (!gate.ok) return json(res, { error: gate.error }, gate.status)
      const len = Number(req.headers['content-length'] || 0)
      if (len > MULTIPART_PART_SIZE * 2) return json(res, { error: 'Part too large' }, 413)
      const body = await readBody(req)
      if (!body.length) return json(res, { error: 'Empty body' }, 400)
      const t0 = Date.now()
      const part = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
        }),
      )
      console.log('mpu part ok', {
        key,
        partNumber,
        ms: Date.now() - t0,
        bytes: body.length,
      })
      return json(res, {
        ok: true,
        partNumber,
        etag: String(part.ETag || '').replace(/^"|"$/g, ''),
      })
    }

    const mpuComplete = pathname.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)\/complete$/)
    if (mpuComplete && req.method === 'POST') {
      const key = sanitizeKey(mpuComplete[1])
      const uploadId = decodeKey(mpuComplete[2])
      if (!key || !uploadId) return json(res, { error: 'Invalid tour key or uploadId' }, 400)
      const gate = await assertCanPutTour(user, key)
      if (!gate.ok) return json(res, { error: gate.error }, gate.status)
      const body = (await readJsonBody(req)) || {}
      const partsIn = Array.isArray(body?.parts) ? body.parts : []
      const parts = partsIn
        .map((p) => ({
          PartNumber: Number(p?.partNumber),
          ETag: String(p?.etag || ''),
        }))
        .filter((p) => Number.isInteger(p.PartNumber) && p.PartNumber >= 1 && p.ETag)
        .sort((a, b) => a.PartNumber - b.PartNumber)
      if (!parts.length) return json(res, { error: 'No parts to complete' }, 400)
      // S3 expects quoted ETags in CompleteMultipartUpload.
      const s3Parts = parts.map((p) => ({
        PartNumber: p.PartNumber,
        ETag: p.ETag.includes('"') ? p.ETag : `"${p.ETag}"`,
      }))
      const t0 = Date.now()
      try {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: s3Parts },
          }),
        )
      } catch (err) {
        console.error('mpu complete failed', err)
        return json(res, { error: err?.message || 'Could not complete multipart upload' }, 400)
      }
      console.log('mpu complete ok', {
        key,
        parts: parts.length,
        size: body?.size || null,
        ms: Date.now() - t0,
      })
      if (gate.created) {
        try {
          await ensureUserEditGrant(user, key)
        } catch (_) {
          /* best-effort */
        }
      }
      return json(res, { ok: true, key, uploadedBy: user.email, parts: parts.length })
    }

    const mpuAbort = pathname.match(/^\/api\/tours\/(.+)\/mpu\/([^/]+)$/)
    if (mpuAbort && req.method === 'DELETE') {
      const key = sanitizeKey(mpuAbort[1])
      const uploadId = decodeKey(mpuAbort[2])
      if (!key || !uploadId) return json(res, { error: 'Invalid tour key or uploadId' }, 400)
      const gate = await assertCanPutTour(user, key)
      if (!gate.ok) return json(res, { error: gate.error }, gate.status)
      try {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        )
      } catch (err) {
        console.warn('mpu abort', err?.message || err)
      }
      return json(res, { ok: true, key, uploadId })
    }

    const m = pathname.match(/^\/api\/tours\/(.+)$/)
    if (m) {
      const key = sanitizeKey(m[1])
      if (!key) return json(res, { error: 'Invalid tour key' }, 400)

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!(await canView(user, key))) return json(res, { error: 'Forbidden' }, 403)
        const rangeHdr = String(req.headers.range || '').trim()
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        const size = Number(head.ContentLength) || 0
        const contentType = head.ContentType || 'application/zip'
        const baseHeaders = {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=60',
          'Accept-Ranges': 'bytes',
          'X-Tour-Key': key,
          ...CORS_HEADERS,
        }
        const rangeMatch = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHdr)
        if (rangeMatch && size > 0) {
          const start = Number(rangeMatch[1])
          const end =
            rangeMatch[2] != null && rangeMatch[2] !== ''
              ? Math.min(Number(rangeMatch[2]), size - 1)
              : size - 1
          if (Number.isInteger(start) && start >= 0 && start < size && end >= start) {
            if (req.method === 'HEAD') {
              res.writeHead(206, {
                ...baseHeaders,
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${size}`,
              })
              res.end()
              return
            }
            const obj = await s3.send(
              new GetObjectCommand({
                Bucket: bucket,
                Key: key,
                Range: `bytes=${start}-${end}`,
              }),
            )
            const chunks = []
            for await (const c of obj.Body) chunks.push(c)
            const buf = Buffer.concat(chunks)
            res.writeHead(206, {
              ...baseHeaders,
              'Content-Length': String(buf.length),
              'Content-Range': `bytes ${start}-${end}/${size}`,
            })
            res.end(buf)
            return
          }
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) })
          res.end()
          return
        }
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const chunks = []
        for await (const c of obj.Body) chunks.push(c)
        const buf = Buffer.concat(chunks)
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Length': String(buf.length),
        })
        res.end(buf)
        return
      }

      if (req.method === 'PUT') {
        // Existing tours require edit. Brand-new keys: any signed-in member may create.
        const gate = await assertCanPutTour(user, key)
        if (!gate.ok) return json(res, { error: gate.error }, gate.status)
        const body = await readBody(req)
        if (!body.length) return json(res, { error: 'Empty body' }, 400)
        const captureStatus = normalizeCaptureStatus(
          req.headers['x-capture-status'] || 'in_progress',
        )
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/zip',
            Metadata: {
              uploadedby: String(user.email || ''),
              uploadedat: new Date().toISOString(),
              capturestatus: captureStatus,
            },
          }),
        )
        if (gate.created) {
          try {
            await ensureUserEditGrant(user, key)
          } catch (_) {
            /* best-effort */
          }
        }
        return json(res, { ok: true, key, uploadedBy: user.email, status: captureStatus })
      }

      if (req.method === 'DELETE') {
        const mayDelete = user?.role === 'admin' || (await canEdit(user, key))
        if (!mayDelete) {
          return json(res, { error: 'Forbidden — edit permission required' }, 403)
        }
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: coverCompanionKey(key) }))
        } catch (_) {
          /* ignore */
        }
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: tourCompanionKey(key) }))
        } catch (_) {
          /* ignore */
        }
        try {
          const prefix = photosPrefix(key)
          const listed = await s3.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }),
          )
          for (const o of listed.Contents || []) {
            try {
              await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }))
            } catch (_) {
              /* ignore */
            }
          }
        } catch (_) {
          /* ignore */
        }
        try {
          await aclDb.prepare('DELETE FROM project_grants WHERE cloud_key = ?').bind(key).run()
        } catch (_) {
          /* grants cleanup best-effort */
        }
        return json(res, { ok: true, key })
      }

      return json(res, { error: 'Method not allowed' }, 405)
    }

    if (pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404)

    return serveStatic(req, res, pathname)
  } catch (err) {
    console.error(err)
    const status = err?.$metadata?.httpStatusCode || 500
    json(res, { error: err?.message || 'Server error' }, status === 404 ? 404 : 500)
  }
})

server.listen(PORT, HOST, () => {
  const email = (process.env.LOCAL_ACL_EMAIL || 'robert.piwin@quadreal.com').trim()
  console.log(`INSP 360 local API + viewer (ACL on)`)
  console.log(`  http://${HOST}:${PORT}/`)
  console.log(`  bucket: ${bucket} (account ${accountId.slice(0, 8)}…)`)
  console.log(`  acl db: ${aclDb.path}`)
  console.log(`  default user: ${email} (override with X-Insp360-Email or ?as=)`)
  console.log(`Open that URL (not file://) so Cloud tours + Admin work.`)
})
