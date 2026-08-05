// Upload data/address-book.json to the private insp360 R2 bucket (config/address-book.json),
// where the worker's admin-only /api/admin/address-book reads it.
//
//   node scripts/import-address-book.mjs      # regenerate from the newest GAL export
//   node scripts/upload-address-book.mjs      # push it to R2 (takes effect within ~5 min)
//
// Uses the same INSP360_R2_* credentials as local-api.mjs (East Industrial .env.local). The file
// stays out of this PUBLIC repo — R2 is the only place production reads it from.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

for (const p of [
  process.env.INSP360_ENV_FILE,
  path.resolve(root, '..', '..', 'QR-East_Industrial_Database', '.env.local'),
  path.resolve(root, '..', 'QR-East_Industrial_Database', '.env.local'),
  path.resolve(root, '.env.local'),
].filter(Boolean)) loadEnvFile(p)

const accountId = process.env.INSP360_R2_ACCOUNT_ID?.trim()
const accessKeyId = process.env.INSP360_R2_ACCESS_KEY_ID?.trim()
const secretAccessKey = process.env.INSP360_R2_SECRET_ACCESS_KEY?.trim()
const bucket = process.env.INSP360_R2_BUCKET_NAME?.trim() || 'insp360'
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing INSP360_R2_* credentials (see local-api.mjs header).')
  process.exit(1)
}

const src = path.join(root, 'data/address-book.json')
if (!fs.existsSync(src)) {
  console.error(`No ${src} — run scripts/import-address-book.mjs first.`)
  process.exit(1)
}
const body = fs.readFileSync(src)
const people = JSON.parse(body.toString()).people?.length ?? 0

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
})
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: 'config/address-book.json',
    Body: body,
    ContentType: 'application/json',
  }),
)
console.log(`uploaded config/address-book.json → r2://${bucket} (${people} people, ${(body.length / 1024).toFixed(0)} KB)`)
