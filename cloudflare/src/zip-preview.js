/**
 * Pull preview.jpg (or first small JPEG) from a ZIP without downloading the whole archive.
 * Works in Workers / browsers (deflate-raw) and Node (pass inflateRaw).
 */

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const MAX_PREVIEW_COMP = 8 * 1024 * 1024

export function coverCompanionKey(tourKey) {
  return String(tourKey || '').replace(/\.(insp360|360skeleton)$/i, '') + '.cover.jpg'
}

/** Pin/map sidecar next to a tour: `building/tour.insp360` → `building/tour.tour.json` */
export function tourCompanionKey(tourKey) {
  return String(tourKey || '').replace(/\.(insp360|360skeleton|zip)$/i, '') + '.tour.json'
}

/** Prefix for per-photo blur overlays: `Tour.insp360` → `Tour.photos/` */
export function photosPrefix(tourKey) {
  return String(tourKey || '').replace(/\.(insp360|360skeleton|zip)$/i, '') + '.photos/'
}

/** Sanitize a photo basename for overlay keys (no path segments). */
export function sanitizePhotoName(photoName) {
  const base = String(photoName || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .pop()
  if (!base || base === '.' || base === '..') return null
  if (!/\.(jpe?g|png)$/i.test(base)) return null
  if (base.includes('\0')) return null
  return base
}

export function photoOverlayKey(tourKey, photoName) {
  const base = sanitizePhotoName(photoName)
  if (!base || !tourKey) return null
  return photosPrefix(tourKey) + base
}

/**
 * @param {(offset:number, length:number) => Promise<Uint8Array|null>} readRange
 * @param {number} totalSize
 * @param {(bytes:Uint8Array) => Promise<Uint8Array>} inflateRaw
 * @param {string[]} preferredNames lowercase basenames to prefer
 */
export async function extractZipImage(readRange, totalSize, inflateRaw, preferredNames) {
  if (!totalSize || totalSize < 22) return null
  const tailLen = Math.min(totalSize, 65558)
  const tail = await readRange(totalSize - tailLen, tailLen)
  if (!tail || tail.length < 22) return null

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const dv = new DataView(tail.buffer, tail.byteOffset)
  const total = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOff = dv.getUint32(eocd + 16, true)
  if (!cdSize || cdOff + cdSize > totalSize) return null

  const cdBuf = await readRange(cdOff, cdSize)
  if (!cdBuf) return null
  const cd = new DataView(cdBuf.buffer, cdBuf.byteOffset)
  const dec = new TextDecoder()
  const preferred = (preferredNames || ['preview.jpg']).map((n) => n.toLowerCase())

  /** @type {{name:string, method:number, comp:number, lho:number, score:number}[]} */
  const candidates = []
  let o = 0
  for (let e = 0; e < total; e++) {
    if (o + 46 > cdBuf.length) break
    if (cd.getUint32(o, true) !== CEN_SIG) break
    const method = cd.getUint16(o + 10, true)
    const comp = cd.getUint32(o + 20, true)
    const nLen = cd.getUint16(o + 28, true)
    const xLen = cd.getUint16(o + 30, true)
    const kLen = cd.getUint16(o + 32, true)
    const lho = cd.getUint32(o + 42, true)
    const name = dec.decode(cdBuf.subarray(o + 46, o + 46 + nLen))
    o += 46 + nLen + xLen + kLen
    const base = name.split('/').pop().toLowerCase()
    if (!/\.(jpe?g|png|webp)$/i.test(base)) continue
    if (comp > MAX_PREVIEW_COMP) continue
    let score = 10
    const prefIdx = preferred.indexOf(base)
    if (prefIdx >= 0) score = prefIdx
    else if (base === 'preview.jpg' || base.endsWith('.cover.jpg')) score = 0
    else score = 50 + candidates.length
    candidates.push({ name, method, comp, lho, score })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.score - b.score)
  const en = candidates[0]

  const lh = await readRange(en.lho, 30)
  if (!lh || lh.length < 30) return null
  const ld = new DataView(lh.buffer, lh.byteOffset)
  if (ld.getUint32(0, true) !== LOC_SIG) return null
  const nLen = ld.getUint16(26, true)
  const xLen = ld.getUint16(28, true)
  const dataOff = en.lho + 30 + nLen + xLen
  const raw = await readRange(dataOff, en.comp)
  if (!raw) return null

  let bytes
  if (en.method === 0) bytes = raw
  else if (en.method === 8) bytes = await inflateRaw(raw)
  else return null

  const lower = en.name.toLowerCase()
  const type = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg'
  return { name: en.name, bytes, contentType: type }
}

export { EOCD_SIG, CEN_SIG, LOC_SIG }
