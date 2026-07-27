/**
 * Merge local SQLite ACL <-> remote D1 insp360-acl.
 * Strategy: union people; local admin role wins; keep cloud-only members;
 * groups matched by name (case-insensitive), members unioned; grants remapped by group name.
 *
 * Usage (from cloudflare/):
 *   $env:CLOUDFLARE_API_TOKEN = "..."
 *   $env:CLOUDFLARE_ACCOUNT_ID = "e46c718ce72e30e61182c9b1c04cf286"
 *   node scripts/merge-acl.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAclDb, newGroupId, normalizeEmail } from '../src/acl-sqlite.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function runWrangler(args) {
  const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const r = spawnSync(process.execPath, [wranglerJs, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error(`wrangler failed: ${r.stderr || r.stdout || r.status}`)
  }
  return r.stdout || ''
}

function parseWranglerResults(out) {
  const start = out.indexOf('[')
  if (start < 0) throw new Error('No JSON array in wrangler output:\n' + out.slice(0, 500))
  const parsed = JSON.parse(out.slice(start))
  const block = Array.isArray(parsed) ? parsed[0] : parsed
  return block?.results || []
}

function d1Select(sql) {
  const out = runWrangler([
    'd1',
    'execute',
    'insp360-acl',
    '--remote',
    '--command',
    sql,
    '--json',
  ])
  return parseWranglerResults(out)
}

function d1File(sqlPath) {
  return runWrangler([
    'd1',
    'execute',
    'insp360-acl',
    '--remote',
    '--file',
    sqlPath,
    '--json',
  ])
}

function esc(s) {
  return String(s ?? '').replace(/'/g, "''")
}

function sqlStr(s) {
  return `'${esc(s)}'`
}

async function localAll(db, sql) {
  const rows = await db.prepare(sql).bind().all()
  return rows.results || []
}

async function main() {
  const local = openAclDb()
  const localUsers = await localAll(local, 'SELECT email, display_name, role, created_by FROM users')
  const localGroups = await localAll(local, 'SELECT id, name FROM groups')
  const localMembers = await localAll(local, 'SELECT group_id, email FROM group_members')
  const localGrants = await localAll(
    local,
    'SELECT cloud_key, principal_type, principal_id, permission FROM project_grants'
  )

  const cloudUsers = d1Select('SELECT email, display_name, role, created_by FROM users')
  const cloudGroups = d1Select('SELECT id, name FROM groups')
  const cloudMembers = d1Select('SELECT group_id, email FROM group_members')
  const cloudGrants = d1Select(
    'SELECT cloud_key, principal_type, principal_id, permission FROM project_grants'
  )

  // --- users merge ---
  const userMap = new Map()
  for (const u of cloudUsers) {
    const email = normalizeEmail(u.email)
    if (!email) continue
    userMap.set(email, {
      email,
      display_name: u.display_name || '',
      role: u.role === 'admin' ? 'admin' : 'member',
      created_by: u.created_by || 'cloud',
    })
  }
  for (const u of localUsers) {
    const email = normalizeEmail(u.email)
    if (!email) continue
    const prev = userMap.get(email)
    const localAdmin = u.role === 'admin'
    if (!prev) {
      userMap.set(email, {
        email,
        display_name: u.display_name || '',
        role: localAdmin ? 'admin' : 'member',
        created_by: u.created_by || 'local-merge',
      })
    } else {
      // local admin wins; otherwise keep existing (often cloud) role
      if (localAdmin) prev.role = 'admin'
      if (!prev.display_name && u.display_name) prev.display_name = u.display_name
    }
  }
  // robert always admin
  {
    const r = userMap.get('robert.piwin@quadreal.com')
    if (r) r.role = 'admin'
    else
      userMap.set('robert.piwin@quadreal.com', {
        email: 'robert.piwin@quadreal.com',
        display_name: '',
        role: 'admin',
        created_by: 'seed',
      })
  }

  // --- groups merge by name ---
  const normName = (n) => String(n || '').trim().toLowerCase()
  /** @type {Map<string, {name:string, localId?:string, cloudId?:string, emails:Set<string>}>} */
  const groupMap = new Map()
  for (const g of cloudGroups) {
    const key = normName(g.name)
    if (!key) continue
    groupMap.set(key, {
      name: g.name,
      cloudId: g.id,
      emails: new Set(),
    })
  }
  for (const g of localGroups) {
    const key = normName(g.name)
    if (!key) continue
    const prev = groupMap.get(key)
    if (!prev) {
      groupMap.set(key, { name: g.name, localId: g.id, emails: new Set() })
    } else {
      prev.localId = g.id
      // prefer local display casing if cloud was empty-ish
      if (g.name && g.name.length >= (prev.name || '').length) prev.name = g.name
    }
  }

  const localGroupById = new Map(localGroups.map((g) => [g.id, g]))
  const cloudGroupById = new Map(cloudGroups.map((g) => [g.id, g]))

  for (const m of cloudMembers) {
    const g = cloudGroupById.get(m.group_id)
    if (!g) continue
    const entry = groupMap.get(normName(g.name))
    if (entry) entry.emails.add(normalizeEmail(m.email))
  }
  for (const m of localMembers) {
    const g = localGroupById.get(m.group_id)
    if (!g) continue
    const entry = groupMap.get(normName(g.name))
    if (entry) entry.emails.add(normalizeEmail(m.email))
  }

  // Assign stable ids: keep cloud id if present, else local id, else new
  for (const entry of groupMap.values()) {
    entry.id = entry.cloudId || entry.localId || newGroupId()
  }

  // --- grants merge (remap group principals by name) ---
  /** @type {Map<string, {cloud_key:string, principal_type:string, principal_id:string, permission:string}>} */
  const grantMap = new Map()
  function grantKey(g) {
    return `${g.cloud_key}\0${g.principal_type}\0${String(g.principal_id).toLowerCase()}`
  }
  function addGrant(g, sideGroupsById) {
    let principalId = g.principal_id
    if (g.principal_type === 'group') {
      const src = sideGroupsById.get(g.principal_id)
      if (!src) return
      const merged = groupMap.get(normName(src.name))
      if (!merged) return
      principalId = merged.id
    } else {
      principalId = normalizeEmail(g.principal_id)
      if (!principalId.includes('@')) return
    }
    const perm = g.permission === 'edit' ? 'edit' : 'view'
    const row = {
      cloud_key: g.cloud_key,
      principal_type: g.principal_type === 'group' ? 'group' : 'user',
      principal_id: principalId,
      permission: perm,
    }
    const k = grantKey(row)
    const prev = grantMap.get(k)
    if (!prev || (prev.permission === 'view' && perm === 'edit')) grantMap.set(k, row)
  }
  for (const g of cloudGrants) addGrant(g, cloudGroupById)
  for (const g of localGrants) addGrant(g, localGroupById)

  // Ensure every group member exists as a user (member role if missing)
  for (const entry of groupMap.values()) {
    for (const email of entry.emails) {
      if (!email.includes('@')) continue
      if (!userMap.has(email)) {
        userMap.set(email, {
          email,
          display_name: '',
          role: 'member',
          created_by: 'merge-group',
        })
      }
    }
  }

  const users = [...userMap.values()].sort((a, b) => a.email.localeCompare(b.email))
  const groups = [...groupMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  const grants = [...grantMap.values()]

  console.log('Merged users:', users.length)
  console.log(
    '  admins:',
    users
      .filter((u) => u.role === 'admin')
      .map((u) => u.email)
      .join(', ')
  )
  console.log('Merged groups:', groups.length)
  console.log('Merged grants:', grants.length)

  // --- write local ---
  await local.batch([
    local.prepare('DELETE FROM project_grants').bind(),
    local.prepare('DELETE FROM group_members').bind(),
    local.prepare('DELETE FROM groups').bind(),
    // keep users table: upsert then delete extras
  ])
  for (const u of users) {
    await local
      .prepare(
        `INSERT INTO users (email, display_name, role, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           display_name = excluded.display_name,
           role = excluded.role`
      )
      .bind(u.email, u.display_name || '', u.role, u.created_by || 'merge')
      .run()
  }
  // remove local users not in merge
  const keep = new Set(users.map((u) => u.email))
  const existingLocal = await localAll(local, 'SELECT email FROM users')
  for (const row of existingLocal) {
    const e = normalizeEmail(row.email)
    if (!keep.has(e)) {
      await local.prepare('DELETE FROM users WHERE email = ? COLLATE NOCASE').bind(e).run()
    }
  }
  for (const g of groups) {
    await local
      .prepare('INSERT INTO groups (id, name) VALUES (?, ?)')
      .bind(g.id, g.name)
      .run()
    for (const email of g.emails) {
      if (!email.includes('@')) continue
      await local
        .prepare('INSERT OR IGNORE INTO group_members (group_id, email) VALUES (?, ?)')
        .bind(g.id, email)
        .run()
    }
  }
  for (const g of grants) {
    await local
      .prepare(
        `INSERT INTO project_grants (cloud_key, principal_type, principal_id, permission)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cloud_key, principal_type, principal_id) DO UPDATE SET
           permission = excluded.permission`
      )
      .bind(g.cloud_key, g.principal_type, g.principal_id, g.permission)
      .run()
  }
  console.log('Local SQLite updated:', local.path)

  // --- write cloud via SQL file ---
  const lines = []
  lines.push('DELETE FROM project_grants;')
  lines.push('DELETE FROM group_members;')
  lines.push('DELETE FROM groups;')
  for (const u of users) {
    lines.push(
      `INSERT INTO users (email, display_name, role, created_by) VALUES (${sqlStr(u.email)}, ${sqlStr(u.display_name || '')}, ${sqlStr(u.role)}, ${sqlStr(u.created_by || 'merge')})
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role;`
    )
  }
  // delete cloud users not in merge
  const keepList = users.map((u) => sqlStr(u.email)).join(',')
  if (keepList) {
    lines.push(`DELETE FROM users WHERE email NOT IN (${keepList});`)
  }
  for (const g of groups) {
    lines.push(`INSERT INTO groups (id, name) VALUES (${sqlStr(g.id)}, ${sqlStr(g.name)});`)
    for (const email of g.emails) {
      if (!email.includes('@')) continue
      lines.push(
        `INSERT OR IGNORE INTO group_members (group_id, email) VALUES (${sqlStr(g.id)}, ${sqlStr(email)});`
      )
    }
  }
  for (const g of grants) {
    lines.push(
      `INSERT INTO project_grants (cloud_key, principal_type, principal_id, permission)
       VALUES (${sqlStr(g.cloud_key)}, ${sqlStr(g.principal_type)}, ${sqlStr(g.principal_id)}, ${sqlStr(g.permission)})
       ON CONFLICT(cloud_key, principal_type, principal_id) DO UPDATE SET permission = excluded.permission;`
    )
  }

  const sqlPath = path.join(root, '.data', 'merge-acl-remote.sql')
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true })
  fs.writeFileSync(sqlPath, lines.join('\n'), 'utf8')
  console.log('Applying remote SQL…', sqlPath)
  d1File(sqlPath)
  console.log('Remote D1 updated.')

  // verify
  const remoteUsers = d1Select('SELECT email, role FROM users ORDER BY role DESC, email')
  console.log('\nCloud users after merge:')
  for (const u of remoteUsers) console.log(`  ${u.role.padEnd(6)} ${u.email}`)
  const remoteGroups = d1Select('SELECT name FROM groups ORDER BY name')
  console.log('\nCloud groups:', remoteGroups.map((g) => g.name).join(' | '))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
