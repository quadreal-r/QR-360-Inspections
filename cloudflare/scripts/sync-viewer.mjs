/**
 * Copy the latest QR-360-Inspections_v*.html into public/index.html for Workers Assets.
 * Also copies insp-capture.html → public/capture.html when present.
 * Stamps standalone product label: QR360-vX.Y.Z
 * Accepts legacy QR-360°_viewer_v*.html names during transition.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const sourceDir = path.resolve(root, '..', 'QR-360-Inspections')
const publicDir = path.join(root, 'public')
const VIEWER_NAME_RE =
  /^(?:QR-360-Inspections_v|QR-360.+_viewer_v)(\d+)\.(\d+)\.(\d+)\.html$/i

if (!fs.existsSync(sourceDir)) {
  console.error('Viewer source folder not found:', sourceDir)
  process.exit(1)
}

const files = fs
  .readdirSync(sourceDir)
  .filter((f) => VIEWER_NAME_RE.test(f))
  .map((f) => {
    const m = f.match(VIEWER_NAME_RE)
    const ver = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
    return { f, ver, full: path.join(sourceDir, f) }
  })
  .sort((a, b) => a.ver[0] - b.ver[0] || a.ver[1] - b.ver[1] || a.ver[2] - b.ver[2])

if (!files.length) {
  console.error('No QR-360-Inspections_v*.html found in', sourceDir)
  process.exit(1)
}

function stampStandaloneQr360(filePath, versionNum) {
  let html = fs.readFileSync(filePath, 'utf8')
  const num = String(versionNum)
  const label = `QR360-v${num}`
  if (/const VERSION_NUM=/.test(html)) {
    html = html.replace(/const VERSION_NUM="[^"]*"/g, `const VERSION_NUM="${num}"`)
  }
  if (/const VIEWER_PRODUCT=/.test(html)) {
    html = html.replace(/const VIEWER_PRODUCT="[^"]*"/g, `const VIEWER_PRODUCT="QR360"`)
  }
  html = html.replace(/(<span id="appVer"[^>]*>)\s*[^<]*(<\/span>)/i, `$1${label}$2`)
  html = html.replace(
    /(<span id="appVer"[^>]*title=")[^"]*(")/i,
    `$1Standalone QR-360° viewer (QR360)$2`,
  )
  fs.writeFileSync(filePath, html, 'utf8')
  return label
}

const latest = files[files.length - 1]
const versionNum = latest.ver.join('.')
fs.mkdirSync(publicDir, { recursive: true })
const dest = path.join(publicDir, 'index.html')
fs.copyFileSync(latest.full, dest)
const label = stampStandaloneQr360(dest, versionNum)

const captureSrc = path.join(sourceDir, 'insp-capture.html')
const captureDest = path.join(publicDir, 'capture.html')
let captureSynced = false
if (fs.existsSync(captureSrc)) {
  fs.copyFileSync(captureSrc, captureDest)
  captureSynced = true
}

fs.writeFileSync(
  path.join(publicDir, 'CURRENT.json'),
  JSON.stringify(
    {
      file: latest.f,
      version: versionNum,
      label,
      product: 'QR360',
      capture: captureSynced ? 'capture.html' : null,
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)
console.log(`Synced ${latest.f} → public/index.html (${label})`)
if (captureSynced) {
  console.log(`Synced insp-capture.html → public/capture.html`)
} else {
  console.warn('insp-capture.html not found — skipped capture.html sync')
}
