/**
 * Silent usage telemetry + daily activity digest email.
 * Recipient is hardcoded — no Admin UI, no env-configurable list.
 */
import { sendResendEmail } from './auth.js'

const REPORT_TO = 'quadreal.rpiwin@gmail.com'

const ALLOWED_TYPES = new Set([
  'login',
  'logout',
  'heartbeat',
  'session_end',
  'tour_open_start',
  'tour_open_ok',
  'tour_open_fail',
  'tour_upload',
  'tour_cover_save',
  'tour_json_save',
  'tour_photo_save',
  'tour_delete',
  'tour_grants_update',
  'offline_triggered',
])

/** Client-ingestable types only (login/logout/tour_* mutations are server-side). */
const CLIENT_TYPES = new Set([
  'heartbeat',
  'session_end',
  'tour_open_start',
  'tour_open_ok',
  'tour_open_fail',
])

const MAX_BATCH = 40
const MAX_BODY_BYTES = 32 * 1024
const MAX_TOUR_KEY_LEN = 512
const MAX_META_JSON_LEN = 1500
/** Cap gap between heartbeats counted as active time (heartbeat interval is ~60s). */
const HEARTBEAT_GAP_CAP_MS = 90_000

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clampDuration(ms) {
  if (ms == null || ms === '') return null
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(Math.floor(n), 24 * 60 * 60 * 1000)
}

function sanitizeTourKey(key) {
  if (key == null || key === '') return null
  const k = String(key).slice(0, MAX_TOUR_KEY_LEN)
  if (k.includes('..')) return null
  return k
}

function sanitizeMeta(meta) {
  if (meta == null) return null
  if (typeof meta !== 'object' || Array.isArray(meta)) return null
  try {
    const s = JSON.stringify(meta)
    if (s.length > MAX_META_JSON_LEN) return s.slice(0, MAX_META_JSON_LEN)
    return s
  } catch {
    return null
  }
}

/**
 * Insert one activity event. Failures are logged but do not throw to callers
 * that should stay fire-and-forget (login / upload hooks).
 */
export async function recordEvent(env, { email, event_type, tour_key, duration_ms, meta } = {}) {
  if (!env?.INSP360_DB) return { ok: false, error: 'no db' }
  const type = String(event_type || '').trim()
  if (!ALLOWED_TYPES.has(type)) return { ok: false, error: 'unknown type' }
  const em = normalizeEmail(email)
  if (!em || !em.includes('@')) return { ok: false, error: 'no email' }

  try {
    await env.INSP360_DB.prepare(
      `INSERT INTO activity_events (email, event_type, tour_key, duration_ms, meta_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(em, type, sanitizeTourKey(tour_key), clampDuration(duration_ms), sanitizeMeta(meta))
      .run()
    return { ok: true }
  } catch (err) {
    console.error('activity recordEvent failed', err?.message || err)
    return { ok: false, error: err?.message || 'insert failed' }
  }
}

/** Prefer event_type; accept type (viewer v1.1.87+). */
function resolveEventType(item) {
  if (!item || typeof item !== 'object') return ''
  return String(item.event_type || item.type || '').trim()
}

/**
 * POST /api/telemetry — session email always from `user`, never from body.
 *
 * Body (single):
 *   { "event_type"|"type": "heartbeat", "tour_key"?: string, "duration_ms"?: number, "meta"?: object }
 *
 * Body (batch):
 *   { "events": [ { "event_type"|"type": "...", ... }, ... ] }
 */
export async function handleTelemetryPost(request, env, user) {
  if (!user?.email) return json({ error: 'Unauthorized' }, 401)
  if (!env.INSP360_DB) return json({ error: 'ACL database not configured' }, 503)

  const rawLen = Number(request.headers.get('Content-Length') || 0)
  if (rawLen > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413)

  let body
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413)
    body = text ? JSON.parse(text) : null
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  let items = []
  if (Array.isArray(body?.events)) {
    items = body.events
  } else if (body && typeof body === 'object' && resolveEventType(body)) {
    items = [body]
  } else {
    return json({ error: 'Expected event_type (or type) or events[]' }, 400)
  }

  if (items.length > MAX_BATCH) {
    return json({ error: `Max ${MAX_BATCH} events per request` }, 400)
  }

  let accepted = 0
  let ignored = 0
  for (const item of items) {
    const type = resolveEventType(item)
    if (!CLIENT_TYPES.has(type)) {
      ignored++
      continue
    }
    const result = await recordEvent(env, {
      email: user.email,
      event_type: type,
      tour_key: item?.tour_key ?? item?.tourKey,
      duration_ms: item?.duration_ms ?? item?.durationMs,
      meta: item?.meta,
    })
    if (result.ok) accepted++
    else ignored++
  }

  return json({ ok: true, accepted, ignored })
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function formatMinutes(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** Estimate active time from heartbeat / session_end events for one user. */
function estimateActiveMs(events) {
  const timed = events
    .filter((e) => e.event_type === 'heartbeat' || e.event_type === 'session_end')
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))

  let total = 0
  for (let i = 0; i < timed.length; i++) {
    const ev = timed[i]
    if (ev.event_type === 'session_end' && ev.duration_ms != null && Number.isFinite(Number(ev.duration_ms))) {
      total += Math.min(Number(ev.duration_ms), 8 * 60 * 60 * 1000)
      continue
    }
    if (ev.event_type === 'heartbeat' && i > 0) {
      const prev = timed[i - 1]
      if (prev.event_type === 'heartbeat' || prev.event_type === 'session_end') {
        const gap = new Date(ev.created_at).getTime() - new Date(prev.created_at).getTime()
        if (Number.isFinite(gap) && gap > 0 && gap <= HEARTBEAT_GAP_CAP_MS) {
          total += gap
        }
      }
    }
  }
  return total
}

/**
 * Build plain-text + HTML digest for [sinceIso, untilIso).
 */
export async function buildDailyReport(env, sinceIso, untilIso) {
  const empty = {
    text: '',
    html: '',
    eventCount: 0,
    uniqueUsers: 0,
  }

  if (!env?.INSP360_DB) return { ...empty, text: 'No database.', html: '<p>No database.</p>' }

  const rows = await env.INSP360_DB.prepare(
    `SELECT email, event_type, tour_key, duration_ms, meta_json, created_at
     FROM activity_events
     WHERE created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
  )
    .bind(sinceIso, untilIso)
    .all()

  const events = rows.results || []
  const periodLabel = sinceIso.slice(0, 10)

  const hoursLabel = (() => {
    const ms = new Date(untilIso).getTime() - new Date(sinceIso).getTime()
    if (!Number.isFinite(ms) || ms <= 0) return '24h'
    const h = Math.round(ms / (60 * 60 * 1000))
    return `${Math.max(1, h)}h`
  })()

  if (!events.length) {
    const text =
      `INSP 360 activity log — ${periodLabel} (${hoursLabel})\n\n` +
      `No activity in this period.\n` +
      `(Cron ran; window ${sinceIso} → ${untilIso})`
    const html =
      `<h2>INSP 360 activity log — ${escapeHtml(periodLabel)} (${escapeHtml(hoursLabel)})</h2>` +
      `<p><em>No activity in this period.</em></p>` +
      `<p style="color:#666;font-size:12px">Window ${escapeHtml(sinceIso)} → ${escapeHtml(untilIso)}</p>`
    return { text, html, eventCount: 0, uniqueUsers: 0 }
  }

  const byUser = new Map()
  for (const ev of events) {
    const em = normalizeEmail(ev.email)
    if (!byUser.has(em)) byUser.set(em, [])
    byUser.get(em).push(ev)
  }

  // --- Sign-ins ---
  const signInLines = []
  for (const [em, list] of [...byUser.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const logins = list.filter((e) => e.event_type === 'login')
    if (!logins.length) continue
    const times = logins.map((e) => e.created_at)
    signInLines.push({
      email: em,
      count: logins.length,
      first: times[0],
      last: times[times.length - 1],
    })
  }

  // --- Time in app ---
  const timeLines = []
  for (const [em, list] of [...byUser.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ms = estimateActiveMs(list)
    if (ms > 0 || list.some((e) => e.event_type === 'heartbeat' || e.event_type === 'session_end')) {
      timeLines.push({ email: em, ms })
    }
  }

  // --- Tour performance ---
  const opensOk = events.filter((e) => e.event_type === 'tour_open_ok')
  const opensFail = events.filter((e) => e.event_type === 'tour_open_fail')
  const loadMs = opensOk
    .map((e) => Number(e.duration_ms))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
  const avg =
    loadMs.length > 0 ? loadMs.reduce((a, b) => a + b, 0) / loadMs.length : null
  const med = percentile(loadMs, 50)
  const p95 = percentile(loadMs, 95)

  const byTour = new Map()
  for (const e of opensOk) {
    const k = e.tour_key || '(unknown)'
    if (!byTour.has(k)) byTour.set(k, [])
    if (e.duration_ms != null && Number.isFinite(Number(e.duration_ms))) {
      byTour.get(k).push(Number(e.duration_ms))
    }
  }
  const slowest = [...byTour.entries()]
    .map(([key, times]) => ({
      key,
      avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      count: times.length,
      max: times.length ? Math.max(...times) : 0,
    }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 5)

  // --- Tour modifications ---
  const MOD_TYPES = [
    ['tour_upload', 'Uploads'],
    ['tour_cover_save', 'Cover saves'],
    ['tour_json_save', 'Tour JSON saves'],
    ['tour_photo_save', 'Photo saves'],
    ['tour_delete', 'Deletes'],
    ['tour_grants_update', 'Access grants'],
  ]
  const modLabel = {
    tour_upload: 'upload',
    tour_cover_save: 'cover',
    tour_json_save: 'tour.json',
    tour_photo_save: 'photo',
    tour_delete: 'delete',
    tour_grants_update: 'grants',
  }
  const mods = events.filter((e) =>
    [
      'tour_upload',
      'tour_cover_save',
      'tour_json_save',
      'tour_photo_save',
      'tour_delete',
      'tour_grants_update',
    ].includes(e.event_type),
  )
  const modCounts = Object.fromEntries(
    MOD_TYPES.map(([type]) => [type, mods.filter((e) => e.event_type === type).length]),
  )
  const modDetailLines = mods.slice(0, 40).map((e) => {
    const action = modLabel[e.event_type] || e.event_type
    return { email: e.email, action, tour_key: e.tour_key || '?', created_at: e.created_at }
  })

  // --- Other ---
  const logouts = events.filter((e) => e.event_type === 'logout')

  const lines = []
  lines.push(`INSP 360 activity log — ${periodLabel} (${hoursLabel})`)
  lines.push(`Window: ${sinceIso} → ${untilIso}`)
  lines.push(`Events: ${events.length} · Unique users: ${byUser.size}`)
  lines.push('')

  lines.push('1. Sign-ins')
  if (!signInLines.length) {
    lines.push('  (none)')
  } else {
    for (const s of signInLines) {
      lines.push(
        `  ${s.email} — ${s.count} login(s); first ${s.first}; last ${s.last}`,
      )
    }
  }
  lines.push('')

  lines.push('2. Time in app (estimated)')
  if (!timeLines.length) {
    lines.push('  (none)')
  } else {
    for (const t of timeLines) {
      lines.push(`  ${t.email} — ${formatMinutes(t.ms)}`)
    }
  }
  lines.push('')

  lines.push('3. Tour performance')
  lines.push(
    `  Opens ok: ${opensOk.length} · Failures: ${opensFail.length}` +
      (loadMs.length
        ? ` · median ${formatMs(med)} · p95 ${formatMs(p95)} · avg ${formatMs(avg)}`
        : ''),
  )
  if (slowest.length) {
    lines.push('  Slowest tours:')
    for (const s of slowest) {
      lines.push(`    ${s.key} — max ${formatMs(s.max)} (avg ${formatMs(s.avg)}, n=${s.count})`)
    }
  }
  lines.push('')

  lines.push('4. Tour modifications')
  lines.push(
    `  Uploads: ${modCounts.tour_upload} · Cover saves: ${modCounts.tour_cover_save}` +
      ` · Tour JSON saves: ${modCounts.tour_json_save} · Photo saves: ${modCounts.tour_photo_save} · Deletes: ${modCounts.tour_delete}` +
      ` · Access grants: ${modCounts.tour_grants_update}`,
  )
  if (modDetailLines.length) {
    for (const m of modDetailLines) {
      lines.push(`    ${m.email} — ${m.action} → ${m.tour_key} @ ${m.created_at}`)
    }
  } else {
    lines.push('  (none)')
  }
  lines.push('')

  lines.push('5. Other')
  lines.push(`  Logouts: ${logouts.length}`)

  const text = lines.join('\n')

  const signInHtml = signInLines.length
    ? `<ul>${signInLines
        .map(
          (s) =>
            `<li><code>${escapeHtml(s.email)}</code> — ${s.count} login(s); first ${escapeHtml(s.first)}; last ${escapeHtml(s.last)}</li>`,
        )
        .join('')}</ul>`
    : '<p>(none)</p>'

  const timeHtml = timeLines.length
    ? `<ul>${timeLines
        .map((t) => `<li><code>${escapeHtml(t.email)}</code> — ${escapeHtml(formatMinutes(t.ms))}</li>`)
        .join('')}</ul>`
    : '<p>(none)</p>'

  const slowHtml = slowest.length
    ? `<ul>${slowest
        .map(
          (s) =>
            `<li><code>${escapeHtml(s.key)}</code> — max ${escapeHtml(formatMs(s.max))} (avg ${escapeHtml(formatMs(s.avg))}, n=${s.count})</li>`,
        )
        .join('')}</ul>`
    : ''

  const modHtml = modDetailLines.length
    ? `<ul>${modDetailLines
        .map(
          (m) =>
            `<li><code>${escapeHtml(m.email)}</code> — ${escapeHtml(m.action)} → <code>${escapeHtml(m.tour_key)}</code> @ ${escapeHtml(m.created_at)}</li>`,
        )
        .join('')}</ul>`
    : '<p>(none)</p>'

  const html =
    `<h2>INSP 360 activity log — ${escapeHtml(periodLabel)} (${escapeHtml(hoursLabel)})</h2>` +
    `<p style="color:#666;font-size:13px">Window ${escapeHtml(sinceIso)} → ${escapeHtml(untilIso)}<br>` +
    `Events: ${events.length} · Unique users: ${byUser.size}</p>` +
    `<h3>1. Sign-ins</h3>${signInHtml}` +
    `<h3>2. Time in app (estimated)</h3>${timeHtml}` +
    `<h3>3. Tour performance</h3>` +
    `<p>Opens ok: ${opensOk.length} · Failures: ${opensFail.length}` +
    (loadMs.length
      ? ` · median ${escapeHtml(formatMs(med))} · p95 ${escapeHtml(formatMs(p95))} · avg ${escapeHtml(formatMs(avg))}`
      : '') +
    `</p>${slowHtml}` +
    `<h3>4. Tour modifications</h3>` +
    `<p>Uploads: ${modCounts.tour_upload} · Cover saves: ${modCounts.tour_cover_save}` +
    ` · Tour JSON saves: ${modCounts.tour_json_save} · Photo saves: ${modCounts.tour_photo_save} · Deletes: ${modCounts.tour_delete}` +
    ` · Access grants: ${modCounts.tour_grants_update}</p>${modHtml}` +
    `<h3>5. Other</h3>` +
    `<p>Logouts: ${logouts.length}</p>`

  return { text, html, eventCount: events.length, uniqueUsers: byUser.size }
}

/** Clamp hours query param: default 24, max 168. */
export function clampActivityHours(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(168, Math.max(1, Math.floor(n)))
}

/**
 * Build activity digest for the last `hours` window (admin fetch / send-now).
 */
export async function getActivityReport(env, hours = 24) {
  const h = clampActivityHours(hours)
  const until = new Date()
  const since = new Date(until.getTime() - h * 60 * 60 * 1000)
  const periodStart = since.toISOString()
  const periodEnd = until.toISOString()
  const report = await buildDailyReport(env, periodStart, periodEnd)
  return {
    periodStart,
    periodEnd,
    hours: h,
    text: report.text,
    html: report.html,
    eventCount: report.eventCount,
    uniqueUsers: report.uniqueUsers,
  }
}

/**
 * Email digest now to REPORT_TO only (no cron dedupe). For admin testing.
 */
export async function sendActivityReportNow(env, hours = 24) {
  const report = await getActivityReport(env, hours)
  const subject = `INSP 360 activity log — ${report.periodStart.slice(0, 10)} (${report.hours}h)`
  const sent = await sendResendEmail(env, {
    to: REPORT_TO,
    subject,
    text: report.text,
    html: report.html,
  })
  if (!sent.ok) {
    return { ok: false, error: sent.error || 'Send failed', ...report }
  }
  return { ok: true, emailedTo: REPORT_TO, ...report }
}

/**
 * Query last 24h, email digest to REPORT_TO (admin only), mark activity_report_sent.
 * Skips the email when there was no activity in the window (once daily via cron ~9am ET).
 */
export async function sendDailyActivityReport(env) {
  const until = new Date()
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000)
  const sinceIso = since.toISOString()
  const untilIso = until.toISOString()
  const periodStart = sinceIso
  const periodEnd = untilIso

  if (!env?.INSP360_DB) {
    console.error('sendDailyActivityReport: no D1')
    return { ok: false, error: 'no db' }
  }

  // Dedupe: skip if an ok send already recorded for this UTC calendar day.
  const dayKey = untilIso.slice(0, 10)
  try {
    const prior = await env.INSP360_DB.prepare(
      `SELECT period_start, period_end, ok FROM activity_report_sent
       WHERE ok = 1 AND substr(period_end, 1, 10) = ?
       LIMIT 1`,
    )
      .bind(dayKey)
      .first()
    if (prior) {
      console.log('sendDailyActivityReport: already sent for', dayKey)
      return { ok: true, skipped: true, reason: 'already_sent' }
    }
  } catch (err) {
    console.error('sendDailyActivityReport dedupe check failed', err?.message || err)
  }

  const report = await buildDailyReport(env, sinceIso, untilIso)
  if (!report.eventCount) {
    console.log('sendDailyActivityReport: no activity, skipping email', dayKey)
    return { ok: true, skipped: true, reason: 'no_activity', eventCount: 0 }
  }

  const subject = `INSP 360 activity log — ${sinceIso.slice(0, 10)} (24h)`

  const sent = await sendResendEmail(env, {
    to: REPORT_TO,
    subject,
    text: report.text,
    html: report.html,
  })

  try {
    await env.INSP360_DB.prepare(
      `INSERT INTO activity_report_sent (period_start, period_end, sent_at, ok)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
       ON CONFLICT(period_start, period_end) DO UPDATE SET
         sent_at = excluded.sent_at,
         ok = excluded.ok`,
    )
      .bind(periodStart, periodEnd, sent.ok ? 1 : 0)
      .run()
  } catch (err) {
    console.error('activity_report_sent insert failed', err?.message || err)
  }

  if (!sent.ok) {
    console.error('sendDailyActivityReport email failed', sent.error)
    return { ok: false, error: sent.error }
  }
  return { ok: true, eventCount: report.eventCount, uniqueUsers: report.uniqueUsers }
}
