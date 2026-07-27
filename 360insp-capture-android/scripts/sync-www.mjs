/**
 * Copy QR-360 capture UI into Capacitor www/ with offline vendor libs.
 * Run: npm run sync-www
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const src = path.resolve(root, '..', 'QR-360-Inspections', 'insp-capture.html')
const dest = path.join(root, 'www', 'index.html')

if (!fs.existsSync(src)) {
  console.error('Source not found:', src)
  process.exit(1)
}

let html = fs.readFileSync(src, 'utf8')

html = html.replace(
  /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[^"]+"><\/script>\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/[^"]+"><\/script>/,
  `<script src="vendor/pdf.min.js"></script>
<script src="vendor/jszip.min.js"></script>`,
)

html = html.replace(
  /pdfjsLib\.GlobalWorkerOptions\.workerSrc\s*=\s*"[^"]+"/,
  'pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"',
)

// Native Capacitor app may use http://localhost — never treat as mixed-content HTTPS block.
if (!html.includes('function isHttpsCapture()')) {
  console.warn('isHttpsCapture() not found — CAP patch skipped')
} else {
  html = html.replace(
    /function isHttpsCapture\(\)\{ return location\.protocol==="https:"; \}/,
    `function isHttpsCapture(){
  try{ if(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return false; }catch(_){}
  return location.protocol==="https:";
}`,
  )
}

// Viewer links: open hosted site in system browser from the app.
html = html.replace(
  /\$\("#openViewerBtn"\)\.onclick=\(\)=>\{location\.href="\/\?desktop=1";\};/,
  `$("#openViewerBtn").onclick=()=>{ openExternalViewer(); };`,
)
html = html.replace(
  /\$\("#homeViewer"\)\.onclick=\(\)=>\{location\.href="\/\?desktop=1";\};/,
  `$("#homeViewer").onclick=()=>{ openExternalViewer(); };`,
)

const bridge = `
<script>
function openExternalViewer(){
  var url="https://insp360-viewer.krutki11.workers.dev/?desktop=1";
  try{
    if(window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App){
      // Prefer system browser via window.open — Capacitor Browser plugin optional
    }
  }catch(_){}
  window.open(url, "_system") || (location.href=url);
}
document.addEventListener("DOMContentLoaded", function(){
  try{
    if(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()){
      document.body.classList.add("native-cap");
      var b=document.getElementById("mixedBanner");
      if(b){ b.classList.remove("show"); b.style.display="none"; }
    }
  }catch(_){}
});
</script>
`

if (!html.includes('function openExternalViewer()')) {
  html = html.replace('</body>', bridge + '\n</body>')
}

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, html, 'utf8')
console.log('Synced', src, '→', dest)
