/**
 * QuadReal branded session auth — OTP via Resend + HMAC session cookie.
 */
import { QR_MARK_DATA_URL } from './qr-mark.js'

export const SESSION_COOKIE = 'insp360_session'
export const SESSION_TTL_SEC = 24 * 60 * 60 // 1 day
export const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const OTP_MAX_ATTEMPTS = 5

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
}

function bytesToB64url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function hmacSign(secret, message) {
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return bytesToB64url(new Uint8Array(sig))
}

async function hmacVerify(secret, message, sigB64) {
  try {
    const key = await hmacKey(secret)
    const sig = b64urlToBytes(sigB64)
    return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(message))
  } catch {
    return false
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function parseCookies(request) {
  const raw = request.headers.get('Cookie') || ''
  const out = {}
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

function sessionCookieHeader(value, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ]
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`)
  return parts.join('; ')
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function createSessionToken(email, env) {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET not configured')
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
  // Use | — emails often contain dots (robert.piwin@…); never split on '.'.
  const payload = `${normalizeEmail(email)}|${exp}`
  const sig = await hmacSign(secret, payload)
  return `${bytesToB64url(new TextEncoder().encode(payload))}.${sig}`
}

export async function verifySession(request, env) {
  const secret = env.SESSION_SECRET
  if (!secret) {
    return { ok: false, error: 'SESSION_SECRET not configured' }
  }

  const cookies = parseCookies(request)
  const token = cookies[SESSION_COOKIE]
  if (!token) return { ok: false, error: 'Sign in required' }

  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, error: 'Invalid session' }

  let payload
  try {
    payload = new TextDecoder().decode(b64urlToBytes(parts[0]))
  } catch {
    return { ok: false, error: 'Invalid session' }
  }

  const ok = await hmacVerify(secret, payload, parts[1])
  if (!ok) return { ok: false, error: 'Invalid session' }

  // New format: email|exp — also accept legacy email.exp via lastIndexOf for soft rollout.
  let email
  let expStr
  const pipe = payload.indexOf('|')
  if (pipe > 0) {
    email = payload.slice(0, pipe)
    expStr = payload.slice(pipe + 1)
  } else {
    const dot = payload.lastIndexOf('.')
    if (dot < 1) return { ok: false, error: 'Invalid session' }
    email = payload.slice(0, dot)
    expStr = payload.slice(dot + 1)
  }
  const exp = Number(expStr)
  if (!email || !Number.isFinite(exp)) return { ok: false, error: 'Invalid session' }
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'Session expired' }

  return { ok: true, email: normalizeEmail(email) }
}

function generateOtpCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(n).padStart(6, '0')
}

async function userExists(env, email) {
  const normalized = normalizeEmail(email)
  if (!normalized || !env.INSP360_DB) return false
  const row = await env.INSP360_DB.prepare(
    'SELECT email FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(normalized)
    .first()
  return !!row
}

async function storeOtp(env, email, code) {
  const codeHash = await sha256Hex(`${normalizeEmail(email)}:${code}`)
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()
  await env.INSP360_DB.prepare(
    `INSERT INTO auth_otps (email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       created_at = excluded.created_at`,
  )
    .bind(normalizeEmail(email), codeHash, expiresAt)
    .run()
}

async function consumeOtp(env, email, code) {
  const normalized = normalizeEmail(email)
  const row = await env.INSP360_DB.prepare(
    'SELECT email, code_hash, expires_at, attempts FROM auth_otps WHERE email = ? COLLATE NOCASE',
  )
    .bind(normalized)
    .first()

  if (!row) return { ok: false, error: 'Invalid or expired code' }

  const attempts = Number(row.attempts || 0)
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await env.INSP360_DB.prepare('DELETE FROM auth_otps WHERE email = ? COLLATE NOCASE')
      .bind(normalized)
      .run()
    return { ok: false, error: 'Too many attempts — request a new code' }
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.INSP360_DB.prepare('DELETE FROM auth_otps WHERE email = ? COLLATE NOCASE')
      .bind(normalized)
      .run()
    return { ok: false, error: 'Invalid or expired code' }
  }

  const codeHash = await sha256Hex(`${normalized}:${String(code || '').trim()}`)
  if (codeHash !== row.code_hash) {
    await env.INSP360_DB.prepare(
      'UPDATE auth_otps SET attempts = attempts + 1 WHERE email = ? COLLATE NOCASE',
    )
      .bind(normalized)
      .run()
    return { ok: false, error: 'Invalid or expired code' }
  }

  await env.INSP360_DB.prepare('DELETE FROM auth_otps WHERE email = ? COLLATE NOCASE')
    .bind(normalized)
    .run()
  return { ok: true }
}

/** Send one email via Resend. `to` may be a string or string[]. */
export async function sendResendEmail(env, { to, subject, text, html }) {
  const apiKey = env.RESEND_API_KEY
  const from = env.RESEND_FROM
  if (!apiKey || !from) {
    console.error('Resend not configured (RESEND_API_KEY / RESEND_FROM)')
    return { ok: false, error: 'Email delivery not configured' }
  }
  const recipients = (Array.isArray(to) ? to : [to])
    .map((e) => normalizeEmail(e))
    .filter((e) => e && e.includes('@'))
  if (!recipients.length) return { ok: false, error: 'No recipients' }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject: String(subject || 'INSP 360').slice(0, 200),
      text: String(text || ''),
      html: html ? String(html) : undefined,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error('Resend error', res.status, body)
    let detail = 'Failed to send email'
    try {
      const j = JSON.parse(body)
      if (j?.message) detail = String(j.message)
    } catch (_) {}
    return { ok: false, error: detail }
  }
  return { ok: true }
}

async function sendOtpEmail(env, email, code) {
  return sendResendEmail(env, {
    to: email,
    subject: 'Your INSP 360 sign-in code',
    text: `Your INSP 360 sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Your INSP 360 sign-in code is <strong style="font-size:20px;letter-spacing:0.12em">${code}</strong>.</p><p>It expires in 10 minutes.</p><p style="color:#666">If you did not request this, you can ignore this email.</p>`,
  })
}

/** Build tour-assignment notification content for one recipient. */
export function buildTourAssignEmail({ displayName, email, tourName, viewerUrl, note, assignedBy }) {
  const hi = displayName ? `Hi ${displayName},` : 'Hi,'
  const tour = tourName || 'a 360° tour'
  const by = assignedBy ? `\nAssigned by: ${assignedBy}` : ''
  const noteBlock = note ? `\n\nNote from admin:\n${note}` : ''
  const subject = `INSP 360: You've been assigned — ${tour}`
  const text =
    `${hi}\n\nYou've been given access to the 360° tour "${tour}" in INSP 360.\n\n` +
    `Open the viewer: ${viewerUrl}\n` +
    `Sign in with this email (${email}), then open Cloud tours to find it.${by}${noteBlock}\n\n— QuadReal INSP 360`
  const noteHtml = note
    ? `<p style="margin:16px 0 0;padding:12px 14px;background:#f4f6f9;border-radius:8px;color:#333"><strong>Note:</strong> ${escapeHtml(note)}</p>`
    : ''
  const html =
    `<p>${escapeHtml(hi)}</p>` +
    `<p>You've been given access to the 360° tour <strong>${escapeHtml(tour)}</strong> in INSP 360.</p>` +
    `<p><a href="${escapeHtml(viewerUrl)}">Open INSP 360 Viewer</a></p>` +
    `<p>Sign in with <strong>${escapeHtml(email)}</strong>, then open <em>Cloud tours</em> to find it.</p>` +
    (assignedBy ? `<p style="color:#666;font-size:13px">Assigned by ${escapeHtml(assignedBy)}</p>` : '') +
    noteHtml +
    `<p style="color:#666;font-size:13px;margin-top:24px">— QuadReal INSP 360</p>`
  return { subject, text, html }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

/**
 * Public auth API — no session required.
 * POST /api/auth/request-code | /api/auth/verify | /api/auth/logout
 */
export async function handleAuthApi(request, env, path) {
  if (path === '/api/auth/request-code' && request.method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }
    const email = normalizeEmail(body?.email)
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Valid email required', email: body?.email || '' }, 400)
    }

    // Anti-enumeration for unknown emails: pretend success without sending.
    // If allowlisted but mail fails, surface the error so the wall can explain Resend limits.
    const allowed = await userExists(env, email)
    if (!allowed) {
      return json({ ok: true, email })
    }
    if (!env.INSP360_DB) return json({ error: 'ACL database not configured' }, 503)
    const code = generateOtpCode()
    await storeOtp(env, email, code)
    const sent = await sendOtpEmail(env, email, code)
    if (!sent.ok) {
      console.error('OTP email failed for', email, sent.error)
      return json(
        {
          error: sent.error || 'Failed to send email',
          email,
          hint: 'With onboarding@resend.dev, codes only go to your Resend account email until you verify a domain.',
        },
        502,
      )
    }

    return json({ ok: true, email })
  }

  if (path === '/api/auth/verify' && request.method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }
    const email = normalizeEmail(body?.email)
    const code = String(body?.code || '').trim()
    if (!email || !/^\d{6}$/.test(code)) {
      return json({ error: 'Email and 6-digit code required', email }, 400)
    }
    if (!env.INSP360_DB) return json({ error: 'ACL database not configured' }, 503)

    const allowed = await userExists(env, email)
    if (!allowed) {
      return json({ error: 'Invalid or expired code', email }, 401)
    }

    const checked = await consumeOtp(env, email, code)
    if (!checked.ok) {
      return json({ error: checked.error || 'Invalid or expired code', email }, 401)
    }

    try {
      const token = await createSessionToken(email, env)
      try {
        const { recordEvent } = await import('./activity.js')
        await recordEvent(env, { email, event_type: 'login' })
      } catch (_) {
        /* telemetry must not block sign-in */
      }
      return json(
        { ok: true, email },
        200,
        { 'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_SEC) },
      )
    } catch (err) {
      console.error(err)
      return json({ error: err?.message || 'Could not create session' }, 500)
    }
  }

  if (path === '/api/auth/logout' && (request.method === 'POST' || request.method === 'GET')) {
    try {
      const sess = await verifySession(request, env)
      if (sess.ok && sess.email) {
        const { recordEvent } = await import('./activity.js')
        await recordEvent(env, { email: sess.email, event_type: 'logout' })
      }
    } catch (_) {
      /* telemetry must not block logout */
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() })
  }

  return null
}

export function wantsHtml(request) {
  const accept = (request.headers.get('Accept') || '').toLowerCase()
  if (accept.includes('text/html')) return true
  const path = new URL(request.url).pathname
  return path === '/' || path.endsWith('.html') || path.endsWith('/')
}

/** QuadReal two-step login wall (email → code, shows destination email). */
export function authWallResponse(request, auth) {
  const detail = String(auth?.error || 'Sign in required').replace(/</g, '&lt;')
  if (!wantsHtml(request)) {
    return new Response(
      JSON.stringify({
        error: auth?.error || 'Unauthorized',
        hint: 'POST /api/auth/request-code then /api/auth/verify',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer realm="INSP 360"',
        },
      },
    )
  }

  const mark = QR_MARK_DATA_URL
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · INSP 360</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --qr-blue:#4974FF; --qr-midnight:#173073; --qr-blue1:#132049; --qr-blue3:#2947A3;
    --qr-light:#B7C9FF; --bg:#132049; --text:#fff; --muted:#B7C9FF; --danger:#FE727D;
    --display:"Playfair Display",Georgia,"Times New Roman",serif;
    --sans:Arial,Helvetica,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{
    display:flex;align-items:center;justify-content:center;
    background-color:var(--bg);
    background-image:
      linear-gradient(180deg, rgba(19,32,73,.72) 0%, rgba(19,32,73,.82) 100%),
      url('/brand/60-birmingham-background.jpg');
    background-size:cover;
    background-position:center;
    background-repeat:no-repeat;
    color:var(--text);font-family:var(--sans);
  }
  .card{
    width:min(480px,92vw);padding:40px 36px 32px;
    border:1px solid var(--qr-blue3);border-radius:14px;
    background:rgba(23,48,115,.92);box-shadow:0 18px 50px rgba(0,0,0,.35);
  }
  .qr-mark{display:block;width:min(196px,72%);height:auto;margin:0 auto 22px}
  h1{
    margin:0 0 6px;font-family:var(--display);font-size:30px;font-weight:600;
    letter-spacing:-.02em;text-align:center;
  }
  .sub{margin:0 0 22px;color:var(--muted);font-size:14px;line-height:1.45;text-align:center}
  .msg{margin:0 0 18px;color:var(--muted);font-size:14px;line-height:1.5;text-align:center}
  .msg strong{color:var(--text);font-weight:700;word-break:break-all}
  label{display:block;font-size:12px;color:var(--muted);margin:0 0 6px;letter-spacing:.02em}
  input{
    width:100%;padding:12px 14px;border-radius:8px;border:1px solid var(--qr-blue3);
    background:rgba(19,32,73,.65);color:var(--text);font-size:16px;outline:none;
  }
  input:focus{border-color:var(--qr-blue);box-shadow:0 0 0 3px rgba(73,116,255,.25)}
  input.code{letter-spacing:.35em;font-size:22px;text-align:center;font-weight:600}
  .err{
    display:none;margin:0 0 14px;padding:8px 10px;border-radius:8px;
    background:rgba(254,114,125,.12);border:1px solid rgba(254,114,125,.35);
    color:#ffc4c9;font-size:12px;
  }
  .err.show{display:block}
  button.primary{
    width:100%;margin-top:14px;padding:12px 16px;border:none;border-radius:8px;
    background:var(--qr-blue);color:#fff;font-size:15px;font-weight:600;cursor:pointer;
  }
  button.primary:hover{filter:brightness(1.08)}
  button.primary:disabled{opacity:.55;cursor:wait}
  .links{display:flex;justify-content:center;gap:16px;margin-top:16px;flex-wrap:wrap}
  .links button{
    background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;
    text-decoration:underline;padding:0;
  }
  .links button:hover{color:var(--text)}
  .step{display:none}
  .step.active{display:block}
  .hint{margin-top:10px;font-size:11px;color:rgba(183,201,255,.65);text-align:center}
</style>
</head>
<body>
  <div class="card">
    <img class="qr-mark" src="${mark}" alt="QuadReal">
    <h1>INSP 360</h1>
    <p class="sub">Sign in with your work email</p>
    <div class="err" id="err">${detail && detail !== 'Sign in required' ? detail : ''}</div>

    <div class="step active" id="stepEmail">
      <form id="formEmail">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required placeholder="you@quadreal.com">
        <button class="primary" type="submit" id="btnSend">Send code</button>
      </form>
    </div>

    <div class="step" id="stepCode">
      <p class="msg">We sent a code to <strong id="destEmail"></strong></p>
      <form id="formCode">
        <label for="code">6-digit code</label>
        <input id="code" class="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required placeholder="••••••">
        <button class="primary" type="submit" id="btnVerify">Verify</button>
      </form>
      <div class="links">
        <button type="button" id="btnResend">Resend code</button>
        <button type="button" id="btnChange">Change email</button>
      </div>
    </div>
    <p class="hint">Access is limited to people added by an admin.</p>
  </div>
<script>
(function(){
  const err=document.getElementById('err');
  const stepEmail=document.getElementById('stepEmail');
  const stepCode=document.getElementById('stepCode');
  const destEmail=document.getElementById('destEmail');
  const emailInput=document.getElementById('email');
  const codeInput=document.getElementById('code');
  let pendingEmail='';

  function showErr(msg){
    if(!msg){ err.classList.remove('show'); err.textContent=''; return; }
    err.textContent=msg; err.classList.add('show');
  }
  if(err.textContent.trim()) err.classList.add('show');

  function showCodeStep(email){
    pendingEmail=email;
    destEmail.textContent=email;
    stepEmail.classList.remove('active');
    stepCode.classList.add('active');
    codeInput.value='';
    codeInput.focus();
    showErr('');
  }
  function showEmailStep(){
    pendingEmail='';
    stepCode.classList.remove('active');
    stepEmail.classList.add('active');
    emailInput.focus();
  }

  async function requestCode(email){
    const res=await fetch('/api/auth/request-code',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'same-origin',
      body:JSON.stringify({email})
    });
    const j=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(j.error||'Could not send code');
    return j.email||email;
  }

  document.getElementById('formEmail').addEventListener('submit',async (e)=>{
    e.preventDefault();
    const email=String(emailInput.value||'').trim().toLowerCase();
    const btn=document.getElementById('btnSend');
    btn.disabled=true; showErr('');
    try{
      const shown=await requestCode(email);
      showCodeStep(shown);
    }catch(ex){ showErr(ex.message||'Could not send code'); }
    finally{ btn.disabled=false; }
  });

  document.getElementById('formCode').addEventListener('submit',async (e)=>{
    e.preventDefault();
    const code=String(codeInput.value||'').trim();
    const btn=document.getElementById('btnVerify');
    btn.disabled=true; showErr('');
    try{
      const res=await fetch('/api/auth/verify',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        body:JSON.stringify({email:pendingEmail, code})
      });
      const j=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(j.error||'Invalid code');
      location.href='/';
    }catch(ex){ showErr(ex.message||'Invalid code'); }
    finally{ btn.disabled=false; }
  });

  document.getElementById('btnResend').addEventListener('click',async ()=>{
    if(!pendingEmail) return;
    showErr('');
    try{
      await requestCode(pendingEmail);
      showErr('');
      codeInput.focus();
    }catch(ex){ showErr(ex.message||'Could not resend'); }
  });
  document.getElementById('btnChange').addEventListener('click',()=>showEmailStep());
})();
</script>
</body>
</html>`

  return new Response(html, {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
