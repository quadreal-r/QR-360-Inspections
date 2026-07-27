import fs from 'node:fs'
const h = fs.readFileSync(
  new URL('../../QR-360-Inspections/insp-capture.html', import.meta.url),
  'utf8',
)
const scripts = [...h.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
console.log('inline scripts', scripts.length)
for (let i = 0; i < scripts.length; i++) {
  try {
    new Function(scripts[i][1])
    console.log('script', i, 'OK', scripts[i][1].length)
  } catch (e) {
    console.error('script', i, 'ERR', e.message)
    const m = String(e.stack || '').match(/<anonymous>:(\d+)/)
    if (m) {
      const n = +m[1]
      const lines = scripts[i][1].split('\n')
      console.log(lines.slice(Math.max(0, n - 4), n + 4).join('\n'))
    }
  }
}
