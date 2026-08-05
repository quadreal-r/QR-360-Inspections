/**
 * Bake a QuadReal Industrial DB export (.xlsx) into the viewer + capture apps.
 *
 * - Viewer: replaces #geoDbEmbedded ({source,fileName,buildings,polys}) and
 *   #geoRtuCounts ({total,byAddress}) in the target QR-360-Inspections_v*.html.
 * - Capture: replaces the built-in `let BUILDINGS = [...]` (same mapping as
 *   capture's parseDbWorkbook) in insp-capture.html.
 *
 * Usage: node scripts/bake-geo-db.mjs <export.xlsx> <viewer.html> [capture.html]
 * Requires the `xlsx` package (resolved from QR-East_Industrial_Database).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('file:///C:/Users/Robert/Projects/QR-East_Industrial_Database/')
const XLSX = require('xlsx')

const [, , xlsxPath, viewerPath, capturePath] = process.argv
if (!xlsxPath || !viewerPath) {
  console.error('Usage: node bake-geo-db.mjs <export.xlsx> <viewer.html> [capture.html]')
  process.exit(1)
}

const wb = XLSX.readFile(xlsxPath)
const need = ['Buildings', 'Tenant Polygons']
for (const s of need) if (!wb.Sheets[s]) { console.error(`Missing sheet "${s}"`); process.exit(1) }

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null }
const fileName = path.basename(xlsxPath)

// ---- buildings (viewer shape: a, p=Portfolio, lat, lng, sf) ----------------
const bRows = XLSX.utils.sheet_to_json(wb.Sheets['Buildings'], { defval: '' })
const buildings = []
const seen = new Set()
const rtuByAddress = {}
let rtuTotal = 0
for (const r of bRows) {
  const a = String(r['Building Address'] || '').trim()
  if (!a || seen.has(a.toLowerCase())) continue
  seen.add(a.toLowerCase())
  const b = { a, p: String(r['Portfolio'] || '').trim() }
  const lat = num(r['Latitude']), lng = num(r['Longitude']), sf = num(r['Sq Ft'])
  if (lat != null) b.lat = lat
  if (lng != null) b.lng = lng
  if (sf != null && sf > 0) b.sf = sf
  buildings.push(b)
  const rc = num(r['RTU Count'])
  if (rc != null && rc > 0) { rtuByAddress[a] = rc; rtuTotal += rc }
}

// ---- tenant polygons (viewer shape: a, s, t, c, clat, clng, path) ----------
const pRows = XLSX.utils.sheet_to_json(wb.Sheets['Tenant Polygons'], { defval: '' })
const polys = []
let badPaths = 0
for (const r of pRows) {
  const a = String(r['Building Address'] || '').trim()
  if (!a) continue
  let path0 = null
  try {
    const parsed = JSON.parse(String(r['Paths (JSON)'] || 'null'))
    if (Array.isArray(parsed) && parsed.length >= 3) {
      path0 = parsed.map((v) => Array.isArray(v) ? [+v[0], +v[1]] : [+v.lat, +v.lng])
        .filter((v) => isFinite(v[0]) && isFinite(v[1]))
    }
  } catch (_) {}
  if (!path0 || path0.length < 3) { badPaths++; continue }
  polys.push({
    a,
    s: String(r['Suite'] || '').trim(),
    t: String(r['Tenant Name'] || '').trim(),
    c: String(r['Color'] || '').trim(),
    clat: num(r['Centroid Lat']),
    clng: num(r['Centroid Lng']),
    path: path0,
  })
}

const geoDb = { source: fileName, fileName, buildings, polys }
const rtuCounts = { total: rtuTotal, byAddress: rtuByAddress }

// ---- capture BUILDINGS (mirror of parseDbWorkbook in insp-capture.html) ----
const clean = (v) => (v == null ? '' : String(v)).replace(/\s*\(x \d+\)/, '').trim()
const uby = {}
for (const r of pRows) {
  const a = String(r['Building Address'] || '').trim()
  if (!a) continue
  const raw = String(r['Suite'] || '').trim(), label = raw.split('\u2014')[0].trim()
  const nm = label.match(/#\s*([\d\-]+)/)
  ;(uby[a] = uby[a] || []).push({ s: label, num: nm ? nm[1] : '', t: String(r['Tenant Name'] || '').trim() })
}
const captureBuildings = []
for (const r of bRows) {
  const address = String(r['Building Address'] || '').trim()
  if (!address) continue
  const m = address.match(/\D*(\d{2,5})/)
  captureBuildings.push({
    address,
    bu: String(r['BU #'] || ''),
    portfolio: clean(r['Portfolio']),
    cluster: clean(r['Cluster']),
    manager: String(r['Manager'] || ''),
    sqft: String(r['Sq Ft'] || ''),
    rtu: r['RTU Count'] || 0,
    lat: r['Latitude'] || '',
    lng: r['Longitude'] || '',
    prefix: m ? m[1] : '',
    units: uby[address] || [],
  })
}

// ---- splice into viewer -----------------------------------------------------
let html = fs.readFileSync(viewerPath, 'utf8')
const geoRe = /(<script type="application\/json" id="geoDbEmbedded">)[\s\S]*?(<\/script>)/
const rtuRe = /(<script type="application\/json" id="geoRtuCounts">)[\s\S]*?(<\/script>)/
if (!geoRe.test(html)) { console.error('viewer: #geoDbEmbedded block not found'); process.exit(1) }
if (!rtuRe.test(html)) { console.error('viewer: #geoRtuCounts block not found'); process.exit(1) }
html = html.replace(geoRe, `$1${JSON.stringify(geoDb)}$2`)
html = html.replace(rtuRe, `$1${JSON.stringify(rtuCounts)}$2`)
fs.writeFileSync(viewerPath, html, 'utf8')

// ---- splice into capture ----------------------------------------------------
if (capturePath) {
  let cap = fs.readFileSync(capturePath, 'utf8')
  const bRe = /(let BUILDINGS = )\[[\s\S]*?\](;\n)/
  if (!bRe.test(cap)) { console.error('capture: BUILDINGS literal not found'); process.exit(1) }
  cap = cap.replace(bRe, `$1${JSON.stringify(captureBuildings)}$2`)
  fs.writeFileSync(capturePath, cap, 'utf8')
}

const withUnits = captureBuildings.filter((b) => b.units.length).length
console.log(`Baked ${fileName}`)
console.log(`  viewer  : ${buildings.length} buildings, ${polys.length} polys (${badPaths} rows skipped for bad/short paths), RTU total ${rtuTotal} across ${Object.keys(rtuByAddress).length} buildings`)
console.log(`  capture : ${captureBuildings.length} buildings, ${withUnits} with tenant units`)
