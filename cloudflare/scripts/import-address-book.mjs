// Build data/address-book.json — the people picker for Admin → People.
//
//   node scripts/import-address-book.mjs [path/to/outlook-gal.csv]
//
// Reads the newest Outlook GAL export from the QR-AddressBook project and keeps only
// @quadreal.com "User" rows (only QuadReal addresses get OTP codes anyway). The worker serves it
// admin-only from the PRIVATE R2 bucket — never from this public repo or as a static asset.
// Refresh = re-export the GAL, re-run this, then node scripts/upload-address-book.mjs.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const GAL_DIR = 'C:/Users/Robert/Projects/QR-AddressBook/output'
const OUT = path.join(ROOT, 'data/address-book.json')

let csvFile = process.argv[2]
if (!csvFile) {
  const candidates = fs
    .readdirSync(GAL_DIR)
    .filter((f) => f.startsWith('outlook-gal-') && f.endsWith('.csv'))
    .sort()
  if (!candidates.length) throw new Error(`No outlook-gal-*.csv in ${GAL_DIR}`)
  csvFile = path.join(GAL_DIR, candidates.at(-1))
}

// Minimal RFC-4180 parser — GAL names contain commas ("Smith, John") and quoted quotes.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const text = fs.readFileSync(csvFile, 'utf8').replace(/^\uFEFF/, '')
const [header, ...rows] = parseCsv(text)
const col = (name) => header.indexOf(name)
const iName = col('Name')
const iTitle = col('Title')
const iDept = col('Department')
const iEmail = col('Email Address')
const iType = col('Entry Type')
if ([iName, iEmail, iType].includes(-1)) {
  throw new Error(`Unexpected header in ${csvFile}: ${header.join(', ')}`)
}

const byEmail = new Map()
for (const r of rows) {
  if ((r[iType] || '').trim() !== 'User') continue
  const email = (r[iEmail] || '').trim().toLowerCase()
  if (!email.endsWith('@quadreal.com')) continue
  byEmail.set(email, {
    name: (r[iName] || '').trim(),
    email,
    title: (r[iTitle] || '').trim(),
    department: (r[iDept] || '').trim(),
  })
}

const people = [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name))
fs.writeFileSync(OUT, JSON.stringify({ people }) + '\n')
console.log(`source : ${csvFile}`)
console.log(`people : ${people.length} @quadreal.com users`)
console.log(`wrote  : ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`)
