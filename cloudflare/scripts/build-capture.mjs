/**
 * Transform Downloads-style insp-capture into repo insp-capture.html
 * with .insp360 export, cloud upload, project meta, and mobile home.
 * Run: node scripts/build-capture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const capturePath = path.resolve(__dirname, '..', '..', 'QR-360-Inspections', 'insp-capture.html')

let html = fs.readFileSync(capturePath, 'utf8')

// ---- title / theme ----
html = html.replace(
  '<title>INSP Capture — 360 Pin Tool</title>',
  '<title>INSP Capture — QR360</title>',
)
html = html.replace(
  '<div class="title">INSP&nbsp;<b>360</b></div>',
  '<div class="title">QR<span style="color:var(--accent)">360</span> Capture</div>',
)

// ---- extra CSS ----
const extraCss = `
  #home{position:fixed;inset:0;z-index:100;background:linear-gradient(165deg,#0a1119 0%,#17222e 55%,#0e1620 100%);
    display:flex;flex-direction:column;align-items:stretch;padding:24px 18px calc(24px + env(safe-area-inset-bottom));overflow:auto}
  #home.hidden{display:none}
  #home .brand{font-size:28px;font-weight:800;letter-spacing:.4px;margin:12px 0 4px}
  #home .brand span{color:var(--accent)}
  #home .sub{color:var(--dim);font-size:14px;line-height:1.45;margin-bottom:22px;max-width:420px}
  #home .hact{display:flex;flex-direction:column;gap:10px;max-width:420px}
  #home .hbtn2{border-radius:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--line);
    text-align:left;display:flex;flex-direction:column;gap:4px}
  #home .hbtn2.primary{background:var(--accent);color:#04121f;border-color:var(--accent)}
  #home .hbtn2.primary .s{color:#1a3040}
  #home .hbtn2 .t{font-weight:800;font-size:16px}
  #home .hbtn2 .s{font-size:12px;color:var(--dim);font-weight:500}
  #mixedBanner{display:none;background:#2a1c08;border-bottom:1px solid #5a3a10;color:#ffd59a;
    padding:8px 12px;font-size:12px;line-height:1.4;z-index:40}
  #mixedBanner.show{display:block}
  #completeBar{display:none;background:var(--panel);border-top:1px solid var(--line);
    padding:8px 10px;gap:8px;align-items:stretch}
  #completeBar.show{display:flex}
  #completeBar .act.done{background:var(--ok);color:#04121f;border-color:var(--ok)}
  #completeBar .act.done .sub{color:#0a3a24}
  .prog{height:8px;background:var(--panel2);border-radius:6px;overflow:hidden;margin:10px 0}
  .prog>i{display:block;height:100%;width:0;background:var(--accent)}
  #authNote{font-size:12px;color:var(--dim);margin-top:6px}
  #authNote.ok{color:var(--ok)} #authNote.bad{color:var(--bad)}
`

html = html.replace('  .safe{padding-bottom:env(safe-area-inset-bottom)}\n</style>', `  .safe{padding-bottom:env(safe-area-inset-bottom)}\n${extraCss}\n</style>`)

// ---- home screen + mixed banner + complete bar + sheets ----
const homeHtml = `
<div id="home">
  <div class="brand">QR<span>360</span> Capture</div>
  <div class="sub">Field capture for INSP 360 — place pins on a floor plan, attach stitched panoramas, then upload to cloud or save for USB.</div>
  <div class="hact">
    <button class="hbtn2 primary" id="homeNew"><span class="t">Create new project</span><span class="s">Name, address, tenant — then load a PDF and drop pins</span></button>
    <button class="hbtn2" id="homeResume"><span class="t">Resume draft</span><span class="s" id="homeResumeSub">No draft on this phone yet</span></button>
    <button class="hbtn2" id="homeViewer"><span class="t">Open cloud tours</span><span class="s">Back to the full viewer (read / author on PC)</span></button>
  </div>
  <div class="note" style="margin-top:20px;max-width:420px" id="homeMixedNote"></div>
</div>
`

html = html.replace('<div id="app">', homeHtml + '\n<div id="app" style="display:none">')
html = html.replace(
  '  <header>',
  `  <div id="mixedBanner">This page is <b>HTTPS</b> — SNAP to the camera at http://192.168.42.1 is blocked (mixed content). Use <b>ATTACH</b> to import stitched JPGs, or open Capture over local HTTP on camera Wi‑Fi.</div>
  <header>`,
)
html = html.replace(
  `  <div id="actionBar" class="safe">
    <button class="act shoot" id="shootBtn" disabled>
      <span id="shootLbl">SNAP 360°</span><span class="sub" id="shootSub">select a pin first</span>
    </button>
    <button class="act" id="attachBtn" disabled>
      <span>ATTACH</span><span class="sub">from phone</span>
    </button>
  </div>
</div>`,
  `  <div id="actionBar" class="safe">
    <button class="act shoot" id="shootBtn" disabled>
      <span id="shootLbl">SNAP 360°</span><span class="sub" id="shootSub">select a pin first</span>
    </button>
    <button class="act" id="attachBtn" disabled>
      <span>ATTACH</span><span class="sub">from phone</span>
    </button>
  </div>
  <div id="completeBar" class="safe">
    <button class="act done" id="completeBtn">
      <span>Complete project</span><span class="sub" id="completeSub">build .insp360</span>
    </button>
  </div>
</div>`,
)

// Project create sheet + complete sheet
const sheetsHtml = `
<!-- ============ NEW PROJECT ============ -->
<div class="sheet" id="projSheet">
  <div class="card">
    <h2>New capture project <button class="x" data-close>✕</button></h2>
    <div class="body">
      <div class="fld"><label>Project name</label><input type="text" id="metaName" placeholder="e.g. Electrical Room — July 2026"></div>
      <div class="fld"><label>Building address</label>
        <button class="btn" id="metaPickBldg" style="width:100%;text-align:left">Select from portfolio…</button>
        <div class="note" id="metaAddrNote" style="margin-top:6px">Required for cloud folder naming</div>
      </div>
      <div class="row2">
        <div class="fld"><label>Tenant</label><input type="text" id="metaTenant" placeholder="Vacant / tenant name"></div>
        <div class="fld"><label>Creator</label><input type="text" id="metaCreator" placeholder="Your name"></div>
      </div>
      <div class="note">Pins and photos stay on this phone (IndexedDB) until you Complete → Upload or Save for USB.</div>
    </div>
    <div class="foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="metaStart">Start capture</button>
    </div>
  </div>
</div>

<!-- ============ COMPLETE / PUBLISH ============ -->
<div class="sheet" id="completeSheet">
  <div class="card">
    <h2>Complete project <button class="x" data-close>✕</button></h2>
    <div class="body">
      <div id="completeSummary" class="note" style="color:var(--ink);font-size:14px;margin-bottom:10px"></div>
      <div class="prog" id="upProg"><i id="upProgFill"></i></div>
      <div id="upProgLbl" class="note" style="margin:0 0 12px"></div>
      <div id="authNote">Checking sign-in…</div>
      <div class="note" style="margin-top:12px">
        Builds a store-only <span class="mono">.insp360</span> (photos + tour.json) matching the viewer schema.
        Upload needs Wi‑Fi + OTP login on this site. Offline? Save for USB and transfer to a PC.
      </div>
    </div>
    <div class="foot" style="flex-wrap:wrap">
      <button class="btn primary" id="btnUploadCloud" style="flex:1 1 100%">Upload to cloud</button>
      <button class="btn" id="btnSaveUsb" style="flex:1">Save for USB</button>
      <button class="btn" id="btnSaveTourJson" style="flex:1">Save .tour.json</button>
    </div>
  </div>
</div>
`

html = html.replace('<!-- ============ BUILDING PICKER ============ -->', sheetsHtml + '\n<!-- ============ BUILDING PICKER ============ -->')

// Menu: replace Export ZIP section
html = html.replace(
  `      <div class="fld"><label>Project</label>
        <div class="row2">
          <button class="btn primary" id="exportZip">Export ZIP</button>
          <button class="btn" id="saveProj">Save .json</button>
        </div>
        <div class="row2" style="margin-top:8px">
          <button class="btn" id="loadProj">Load project</button>
          <button class="btn warn" id="resetProj">Reset</button>
        </div>
        <div class="note">Everything autosaves on this device. <b>Export ZIP</b> gives you all renamed 360 photos + <span class="mono">manifest.json</span> + the annotated plan. Load a <span class="mono">.json</span> or <span class="mono">.zip</span> to resume on another device.</div>
      </div>`,
  `      <div class="fld"><label>Project</label>
        <div class="row2">
          <button class="btn primary" id="completeMenuBtn">Complete / publish</button>
          <button class="btn" id="saveProj">Save draft .json</button>
        </div>
        <div class="row2" style="margin-top:8px">
          <button class="btn" id="loadProj">Load project</button>
          <button class="btn warn" id="resetProj">Reset</button>
        </div>
        <div class="row2" style="margin-top:8px">
          <button class="btn" id="homeBackBtn">Capture home</button>
          <button class="btn" id="openViewerBtn">Viewer</button>
        </div>
        <div class="note">Autosaves on this device. <b>Complete</b> builds a real <span class="mono">.insp360</span> + tour.json for cloud upload or USB. Naming matches viewer tours: <span class="mono">145 (1).jpg</span>.</div>
      </div>`,
)

html = html.replace(
  `Photos are named <span class="mono" id="egName">6990-01.jpg</span>. Prefix defaults from the building address; change it per site.`,
  `Photos are named <span class="mono" id="egName">6990 (1).jpg</span>. Prefix defaults from the street number; change it per site.`,
)

html = html.replace(
  `accept=".json,.zip,application/json,application/zip"`,
  `accept=".json,.zip,.insp360,application/json,application/zip"`,
)

// ---- JS state + naming ----
html = html.replace(
  `const S = {
  building:null, pdfDoc:null, pdfName:null, pdfBytes:null,
  pageNum:1, pageCount:1,
  pins:[], selPin:null,
  zoom:1, panX:0, panY:0, baseW:0, baseH:0,
  mode:"add",                 // "add" | "move"
  prefix:"", next:1,
  opt:{stitch:true, hdr:false, advance:true, ip:"192.168.42.1"},
};`,
  `const S = {
  building:null, pdfDoc:null, pdfName:null, pdfBytes:null,
  pageNum:1, pageCount:1,
  pins:[], selPin:null,
  zoom:1, panX:0, panY:0, baseW:0, baseH:0,
  mode:"add",                 // "add" | "move"
  prefix:"", next:1,
  meta:{ name:"", address:"", tenant:"", sf:"", creator:"", type:"", created:null, modified:null },
  opt:{stitch:true, hdr:false, advance:true, ip:"192.168.42.1"},
  completed:false,
};
const CAPTURE_VER="1.0.0";
const CLOUD_API_HOSTED="https://insp360-viewer.krutki11.workers.dev";
const CLOUD_MPU_PART_SIZE=8*1024*1024;
const CLOUD_MPU_MIN_SIZE=16*1024*1024;
`,
)

html = html.replace(
  `function serialize(){
  return {v:1, building:S.building, pdfName:S.pdfName, pageCount:S.pageCount,
    prefix:S.prefix, next:S.next, opt:S.opt,
    pins:S.pins.map(p=>({id:p.id,page:p.page,x:p.x,y:p.y,seq:p.seq,name:p.name,note:p.note,photoId:p.photoId,ts:p.ts}))};
}`,
  `function serialize(){
  return {v:2, captureVer:CAPTURE_VER, building:S.building, pdfName:S.pdfName, pageCount:S.pageCount,
    prefix:S.prefix, next:S.next, opt:S.opt, meta:S.meta, completed:!!S.completed,
    pins:S.pins.map(p=>({id:p.id,page:p.page,x:p.x,y:p.y,seq:p.seq,name:p.name,note:p.note,photoId:p.photoId,ts:p.ts}))};
}`,
)

html = html.replace(
  `function pad(n){return String(n).padStart(2,"0");}
function pinName(seq){return \`\${S.prefix}-\${pad(seq)}\`;}`,
  `function pinName(seq){return \`\${S.prefix} (\${seq})\`;}
function photoFileName(p){return (p.name||pinName(p.seq))+".jpg";}`,
)

html = html.replace(
  `function updateEg(){$("#egName").textContent=\`\${S.prefix||"SITE"}-01.jpg\`;}`,
  `function updateEg(){$("#egName").textContent=\`\${S.prefix||"SITE"} (1).jpg\`;}`,
)

// pickBuilding: also fill meta
html = html.replace(
  `function pickBuilding(b){
  S.building=b; S.prefix=b.prefix||b.bu||"SITE"; S.next=nextFreeNum();
  $("#bldgA").textContent=b.address;
  $("#bldgB").textContent=\`\${b.portfolio.replace(" Business Park","")} · BU \${b.bu} · \${b.rtu||0} RTU\`;
  $("#setPrefix").value=S.prefix;$("#setNext").value=S.next;updateEg();
  closeSheet("#bldgSheet");save();toast("Building set — now open its PDF drawing");
}`,
  `function pickBuilding(b){
  S.building=b; S.prefix=b.prefix||b.bu||"SITE"; S.next=nextFreeNum();
  S.meta.address=b.address||"";
  S.meta.type=(b.portfolio||"").replace(/ \\(x \\d+\\)$/,"")||S.meta.type;
  S.meta.sf=b.sqft||S.meta.sf||"";
  if(!S.meta.name) S.meta.name=(S.prefix||"Site")+" Capture";
  $("#bldgA").textContent=b.address;
  $("#bldgB").textContent=\`\${b.portfolio.replace(" Business Park","")} · BU \${b.bu} · \${b.rtu||0} RTU\`;
  $("#setPrefix").value=S.prefix;$("#setNext").value=S.next;updateEg();
  $("#metaAddrNote").textContent=b.address;
  closeSheet("#bldgSheet");save();toast("Building set — now open its PDF drawing");
  updateCompleteBar();
}`,
)

// Update action bar + complete bar after refreshPins
html = html.replace(
  `  $("#pinCount").textContent=\`(\${S.pins.length}, \${S.pins.filter(p=>p.photoId).length} shot)\`;
}`,
  `  $("#pinCount").textContent=\`(\${S.pins.length}, \${S.pins.filter(p=>p.photoId).length} shot)\`;
  updateCompleteBar();
}
function updateCompleteBar(){
  const bar=$("#completeBar"); if(!bar) return;
  const n=S.pins.length, shot=S.pins.filter(p=>p.photoId).length;
  if(n>0){ bar.classList.add("show");
    $("#completeSub").textContent=shot===n?\`all \${n} pinned\`:\`\${shot}/\${n} photos · can still complete\`;
  } else bar.classList.remove("show");
}`,
)

// Mixed content in camConnect / describeNetErr already mostly there — enhance snap early exit
html = html.replace(
  `async function snap(){
  const p=S.selPin;if(!p){toast("Select a pin first");return;}
  const node=$(\`#pinLayer .pin[data-id="\${p.id}"]\`);
  openSheet("#camSheet");$("#log").innerHTML="";
  const shoot=$("#shootBtn");shoot.disabled=true;$("#shootSub").textContent="capturing…";
  try{`,
  `async function snap(){
  const p=S.selPin;if(!p){toast("Select a pin first");return;}
  if(location.protocol==="https:"){
    openSheet("#camSheet");$("#log").innerHTML="";
    logc("Blocked: HTTPS page cannot SNAP to http://"+S.opt.ip+" (mixed content).","e");
    logc("Use ATTACH to import a stitched JPG from the Insta360 app / Files.","i");
    logc("Or open Capture over local HTTP while on camera Wi‑Fi.","i");
    toast("SNAP blocked on HTTPS — use ATTACH");
    return;
  }
  openSheet("#camSheet");$("#log").innerHTML="";
  const shoot=$("#shootBtn");shoot.disabled=true;$("#shootSub").textContent="capturing…";
  try{`,
)

// Also offer download copy when attaching
html = html.replace(
  `async function attachBlob(p,blob){
  const pid="ph"+p.id;
  await idbPut("photos",pid,blob);
  p.photoId=pid;p.ts=Date.now();
  refreshPins();updateActionBar();save();
}`,
  `async function attachBlob(p,blob,opts){
  opts=opts||{};
  const pid="ph"+p.id;
  await idbPut("photos",pid,blob);
  p.photoId=pid;p.ts=Date.now();
  if(p.name && !/\\.jpg$/i.test(p.name)){ /* name is stem */ }
  refreshPins();updateActionBar();save();
  if(opts.download!==false){
    try{ dl(blob, photoFileName(p)); }catch(_){}
  }
}`,
)

// Replace exportZip entirely with insp360 builder + cloud
const oldExport = `/* ============================================================
   EXPORT
   ============================================================ */
async function exportZip(){
  if(!S.pins.length){toast("Nothing to export yet");return;}
  toast("Building ZIP…",3000);
  const zip=new JSZip();
  const folder=(S.building?S.building.address.replace(/[^\\w -]/g,"").trim():"site").replace(/\\s+/g,"_");
  const photos=zip.folder(folder);
  const manifest={building:S.building,pdf:S.pdfName,exported:new Date().toISOString(),prefix:S.prefix,pins:[]};
  for(const p of [...S.pins].sort((a,b)=>a.seq-b.seq)){
    const entry={name:p.name,page:p.page,x:+p.x.toFixed(4),y:+p.y.toFixed(4),note:p.note||"",file:null,captured:p.ts?new Date(p.ts).toISOString():null};
    if(p.photoId){const b=await idbGet("photos",p.photoId);if(b){const fn=p.name+".jpg";photos.file(fn,b);entry.file=folder+"/"+fn;}}
    manifest.pins.push(entry);
  }
  zip.file("manifest.json",JSON.stringify(manifest,null,2));
  zip.file("project.json",JSON.stringify(serialize(),null,2));
  if(S.pdfBytes)zip.file(S.pdfName||"drawing.pdf",S.pdfBytes);
  const out=await zip.generateAsync({type:"blob"});
  dl(out,\`\${folder}_360capture.zip\`);
  toast("ZIP ready ✓");
}
function saveProjJson(){
  dl(new Blob([JSON.stringify(serialize(),null,2)],{type:"application/json"}),
    \`\${(S.building?S.building.prefix:"site")}_project.json\`);
}
function dl(blob,name){const a=el("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);}
`

const newExport = `/* ============================================================
   EXPORT — store-only .insp360 + tour.json v2
   ============================================================ */
function bytesToB64(bytes){
  let s=""; const CH=0x8000;
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  for(let i=0;i<u8.length;i+=CH) s+=String.fromCharCode.apply(null, u8.subarray(i,i+CH));
  return btoa(s);
}
function shortStem(addr){
  const a=String(addr||"").trim();
  const m=a.match(/^(\\d{1,6})\\b\\s*([A-Za-z][A-Za-z0-9'\\.\\-]*)/);
  if(m) return (m[1]+" "+m[2]).trim();
  const n=a.match(/^(\\d{1,6})\\b/);
  return n?n[1]:(S.prefix||"site");
}
function inspFileName(){
  const stem=shortStem(S.meta.address||(S.building&&S.building.address)||"");
  let title=String(S.meta.name||"").trim()||"Capture";
  title=title.replace(/[\\\\/:*?"<>|]+/g," ").replace(/\\s+/g," ").trim();
  if(stem){
    const esc=s=>String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g,function(ch){return "\\\\"+ch;});
    const re=new RegExp("^"+esc(stem)+"\\\\s*[—–\\\\-:|]?\\\\s*","i");
    if(re.test(title)) title=title.replace(re, stem+" ").replace(/\\s+/g," ").trim();
    else if(!title.toLowerCase().startsWith(stem.toLowerCase())) title=(stem+" "+title).replace(/\\s+/g," ").trim();
  }
  return title+".insp360";
}
function cloudObjectKey(){
  const addr=String(S.meta.address||(S.building&&S.building.address)||"tours").trim()
    .replace(/[\\\\/:*?"<>|]+/g," ").replace(/\\s+/g," ").trim()||"tours";
  return sanitizeCloudKey(addr+"/"+inspFileName());
}
function sanitizeCloudKey(name){
  let k=String(name||"").trim().replace(/\\\\/g,"/").replace(/^\\/+/,"");
  if(k.includes("..")) k=k.split("/").filter(p=>p&&p!=="..").join("/");
  k=k.replace(/[\\u0000-\\u001f\\u007f]/g,"");
  if(!k) k="tour.insp360";
  if(!/\\.insp360$/i.test(k)) k+=".insp360";
  if(k.length>512) k=k.slice(0,504)+".insp360";
  return k;
}
function buildTourJson(){
  const ordered=[...S.pins].sort((a,b)=>a.seq-b.seq);
  const order=[], tours={};
  for(const p of ordered){
    if(!p.photoId) continue;
    const fn=photoFileName(p);
    order.push(fn);
    tours[fn]={ objects:[], view:{ lon:0, lat:0, fov:90 } };
  }
  const now=new Date().toISOString();
  if(!S.meta.created) S.meta.created=now;
  S.meta.modified=now;
  const out={
    version:2,
    lockView:true,
    north:null,
    tours,
    order,
    meta:{
      name:S.meta.name||"",
      address:S.meta.address||(S.building&&S.building.address)||"",
      tenant:S.meta.tenant||"",
      sf:S.meta.sf||(S.building&&S.building.sqft)||"",
      creator:S.meta.creator||"",
      type:S.meta.type||(S.building&&S.building.portfolio)||"",
      created:S.meta.created,
      modified:S.meta.modified
    }
  };
  if(S.pdfBytes || S.pins.length){
    const markers=ordered.filter(p=>p.photoId).map(p=>({
      x:+(+p.x).toFixed(6), y:+(+p.y).toFixed(6),
      target:photoFileName(p), label:p.note||p.name||""
    }));
    const plan={
      name:S.pdfName||"Floor plan",
      markers
    };
    if(S.pdfBytes) plan.pdf=bytesToB64(S.pdfBytes instanceof Uint8Array?S.pdfBytes:new Uint8Array(S.pdfBytes));
    out.plan={ active:0, plans:[plan] };
  }
  return out;
}
async function buildInsp360Blob(onProgress){
  if(!window.JSZip) throw new Error("JSZip missing — reconnect once to cache libraries");
  const zip=new JSZip();
  const ordered=[...S.pins].sort((a,b)=>a.seq-b.seq);
  const withPhoto=ordered.filter(p=>p.photoId);
  if(!withPhoto.length) throw new Error("Attach at least one photo before completing");
  let i=0;
  for(const p of withPhoto){
    const b=await idbGet("photos",p.photoId);
    if(!b) continue;
    zip.file(photoFileName(p), b, { compression:"STORE" });
    i++;
    if(onProgress) onProgress(i, withPhoto.length+1, "Packing "+photoFileName(p));
  }
  const tour=buildTourJson();
  zip.file("tour.json", JSON.stringify(tour,null,2), { compression:"STORE" });
  if(onProgress) onProgress(withPhoto.length+1, withPhoto.length+1, "Writing tour.json");
  // Also embed a capture draft for resume on another device
  zip.file("capture-draft.json", JSON.stringify(serialize(),null,2), { compression:"STORE" });
  return zip.generateAsync({ type:"blob", compression:"STORE", streamFiles:true }, meta=>{
    if(onProgress && meta && meta.percent!=null) onProgress(null,null,"Compressing "+Math.round(meta.percent)+"%");
  });
}
function setUpProg(pct, lbl){
  const fill=$("#upProgFill"), lab=$("#upProgLbl");
  if(fill) fill.style.width=Math.max(0,Math.min(100,pct||0))+"%";
  if(lab) lab.textContent=lbl||"";
}
function openCompleteSheet(){
  const n=S.pins.length, shot=S.pins.filter(p=>p.photoId).length;
  const missing=n-shot;
  $("#completeSummary").innerHTML=
    \`<b>\${esc(S.meta.name||"Untitled")}</b><br>\${esc(S.meta.address||"No address")}<br>\`+
    \`\${shot} photo\${shot===1?"":"s"} · \${n} pin\${n===1?"":"s"}\`+
    (missing?\` · <span style="color:var(--bad)">\${missing} missing</span>\`:"");
  setUpProg(0,"");
  openSheet("#completeSheet");
  refreshAuthNote();
}
async function saveForUsb(){
  try{
    setUpProg(5,"Building .insp360…");
    const blob=await buildInsp360Blob((a,b,ph)=>setUpProg(b?Math.round(5+40*(a/b)):20, ph||"Packing…"));
    const name=inspFileName();
    dl(blob, name);
    setUpProg(100,"Saved "+name);
    toast("Saved "+name+" — copy via USB to PC");
    S.completed=true; save();
  }catch(e){ toast(e.message||"Save failed"); setUpProg(0, String(e.message||e)); }
}
async function saveTourJsonOnly(){
  try{
    const tour=buildTourJson();
    const name=inspFileName().replace(/\\.insp360$/i,"")+".tour.json";
    dl(new Blob([JSON.stringify(tour,null,2)],{type:"application/json"}), name);
    toast("Saved "+name);
  }catch(e){ toast(e.message||"Save failed"); }
}

/* ---- Cloud API (same-origin Worker cookies) ---- */
function cloudApiOrigin(){
  const host=(location.hostname||"").toLowerCase();
  const port=String(location.port||"");
  if(host==="127.0.0.1"||host==="localhost"){
    if(port==="8788") return location.origin;
    return "http://127.0.0.1:8788";
  }
  if(/workers\\.dev$/i.test(host)) return location.origin;
  if(location.protocol==="http:"||location.protocol==="https:") return location.origin;
  return CLOUD_API_HOSTED;
}
function cloudCreds(base){
  return (base.indexOf("127.0.0.1")>=0||base.indexOf("localhost")>=0)?"omit":"include";
}
function isLocalApi(base){ return !!(base&&(base.indexOf("127.0.0.1")>=0||base.indexOf("localhost")>=0)); }
function encodeTourKeyPath(key){ return String(key||"").split("/").map(encodeURIComponent).join("/"); }
async function cloudFetch(path, opts){
  opts=opts||{};
  const base=cloudApiOrigin();
  const headers=new Headers(opts.headers||{});
  if(isLocalApi(base)){
    try{
      const em=(localStorage.getItem("insp360.aclEmail")||"").trim()||"robert.piwin@quadreal.com";
      headers.set("X-Insp360-Email", em);
    }catch(_){ headers.set("X-Insp360-Email","robert.piwin@quadreal.com"); }
  }
  return fetch(base+path, { ...opts, headers, credentials:cloudCreds(base) });
}
async function refreshAuthNote(){
  const note=$("#authNote"); if(!note) return;
  try{
    const res=await cloudFetch("/api/me");
    if(res.status===401){
      note.className="bad";
      note.innerHTML='Not signed in — open <a href="/" style="color:var(--accent)">the viewer</a>, enter your email code, then return here.';
      return null;
    }
    if(!res.ok){ note.className="bad"; note.textContent="Auth check failed ("+res.status+")"; return null; }
    const me=await res.json();
    note.className="ok";
    note.textContent="Signed in as "+(me.email||me.name||"user")+(me.role?" · "+me.role:"");
    return me;
  }catch(e){
    note.className="bad";
    note.textContent="Offline or API unreachable — use Save for USB.";
    return null;
  }
}
async function uploadBlobPut(key, blob, contentType, onProgress){
  const base=cloudApiOrigin();
  const path="/api/tours/"+encodeTourKeyPath(key);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open("PUT", base+path);
    xhr.withCredentials=cloudCreds(base)==="include";
    xhr.responseType="text";
    xhr.setRequestHeader("Content-Type", contentType||"application/zip");
    if(isLocalApi(base)){
      try{ xhr.setRequestHeader("X-Insp360-Email",(localStorage.getItem("insp360.aclEmail")||"robert.piwin@quadreal.com")); }catch(_){}
    }
    xhr.upload.onprogress=e=>{
      if(typeof onProgress==="function"){
        const total=e.lengthComputable?e.total:(blob&&blob.size)||0;
        onProgress({ loaded:e.loaded||0, total:total||0 });
      }
    };
    xhr.onload=()=>resolve({ ok:xhr.status>=200&&xhr.status<300, status:xhr.status, text:()=>xhr.responseText||"" });
    xhr.onerror=()=>reject(new Error("Network error during upload"));
    xhr.send(blob);
  });
}
async function uploadMultipart(key, blob, contentType, onProgress){
  const total=blob.size||0;
  const base=cloudApiOrigin();
  if(isLocalApi(base) || total<CLOUD_MPU_MIN_SIZE){
    return uploadBlobPut(key, blob, contentType, onProgress);
  }
  const created=await cloudFetch("/api/tours/"+encodeTourKeyPath(key)+"/mpu", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ size:total, contentType:contentType||"application/zip" })
  });
  if(!created.ok){
    let msg="Could not start upload ("+created.status+")";
    try{ const j=await created.json(); if(j&&j.error) msg=j.error; }catch(_){}
    throw new Error(msg);
  }
  const j=await created.json();
  const uploadId=j.uploadId;
  const partSize=Number(j.partSize)||CLOUD_MPU_PART_SIZE;
  if(!uploadId) throw new Error("No uploadId");
  const totalParts=Math.max(1, Math.ceil(total/partSize));
  const parts=[];
  let loaded=0;
  for(let partNumber=1; partNumber<=totalParts; partNumber++){
    const start=(partNumber-1)*partSize;
    const end=Math.min(total, start+partSize);
    const chunk=blob.slice(start, end);
    const res=await cloudFetch(
      "/api/tours/"+encodeTourKeyPath(key)+"/mpu/"+encodeURIComponent(uploadId)+"/parts/"+partNumber,
      { method:"PUT", headers:{ "Content-Type":"application/octet-stream" }, body:chunk }
    );
    if(!res.ok) throw new Error("Part "+partNumber+" failed ("+res.status+")");
    const etag=(res.headers.get("ETag")||"").replace(/"/g,"") || (await res.json().catch(()=>({}))).etag;
    if(!etag){
      const body=await res.json().catch(()=>null);
      if(body&&body.etag) parts.push({ partNumber, etag:String(body.etag).replace(/"/g,"") });
      else throw new Error("Missing ETag for part "+partNumber);
    } else parts.push({ partNumber, etag });
    loaded+=chunk.size;
    if(onProgress) onProgress({ loaded, total });
  }
  const complete=await cloudFetch("/api/tours/"+encodeTourKeyPath(key)+"/mpu/"+encodeURIComponent(uploadId)+"/complete", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ parts, size:total })
  });
  if(!complete.ok){
    let msg="Finalize failed ("+complete.status+")";
    try{ const jj=await complete.json(); if(jj&&jj.error) msg=jj.error; }catch(_){}
    throw new Error(msg);
  }
  return { ok:true, status:complete.status };
}
async function uploadTourSidecar(key, tourText){
  const res=await cloudFetch("/api/tours/"+encodeTourKeyPath(key)+"/tour", {
    method:"PUT",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body:tourText
  });
  return !!(res&&res.ok);
}
async function queueOfflineUpload(key, tourText){
  const q=(await idbGet("kv","uploadQueue"))||[];
  q.push({ key, tourText, at:Date.now(), name:inspFileName() });
  await idbPut("kv","uploadQueue", q);
}
async function flushUploadQueue(){
  if(!navigator.onLine) return;
  const q=(await idbGet("kv","uploadQueue"))||[];
  if(!q.length) return;
  // Photos live in draft — rebuild from current draft if key matches, else skip with note
  toast("Retrying queued cloud upload…");
  try{
    await uploadToCloud({ fromQueue:true });
    await idbPut("kv","uploadQueue", []);
  }catch(e){ console.warn("queue flush", e); }
}
async function uploadToCloud(opts){
  opts=opts||{};
  const me=await refreshAuthNote();
  if(!me && !opts.force){
    if(!navigator.onLine){
      const tour=buildTourJson();
      await queueOfflineUpload(cloudObjectKey(), JSON.stringify(tour,null,2));
      toast("Offline — upload queued. Will retry on Wi‑Fi.");
      return;
    }
    toast("Sign in on the viewer first (email code), then retry upload.", true);
    return;
  }
  try{
    setUpProg(5,"Building .insp360…");
    const blob=await buildInsp360Blob((a,b,ph)=>setUpProg(b?Math.round(5+25*(a/b)):15, ph||"Packing…"));
    const key=cloudObjectKey();
    setUpProg(30,"Uploading "+inspFileName()+"…");
    const res=await uploadMultipart(key, blob, "application/zip", p=>{
      const tot=Math.max(1,p.total||blob.size||1);
      const pct=30+Math.round((Math.max(0,p.loaded||0)/tot)*55);
      setUpProg(pct, "Uploading "+Math.round((p.loaded||0)/1e6)+" / "+Math.round(tot/1e6)+" MB");
    });
    if(!res.ok) throw new Error("Upload failed ("+res.status+")");
    setUpProg(90,"Uploading tour.json sidecar…");
    const tourText=JSON.stringify(buildTourJson(),null,2);
    const ok=await uploadTourSidecar(key, tourText);
    if(!ok) toast("Archive uploaded; sidecar tour.json failed — open in viewer and Save", true);
    setUpProg(100,"Uploaded · "+key);
    S.completed=true; save();
    toast("Uploaded to cloud ✓");
    await idbPut("kv","uploadQueue", []);
  }catch(e){
    const msg=String((e&&e.message)||e||"Upload failed");
    setUpProg(0, msg);
    if(!navigator.onLine || /network|fetch/i.test(msg)){
      try{
        const tour=buildTourJson();
        await queueOfflineUpload(cloudObjectKey(), JSON.stringify(tour,null,2));
        toast("Queued for upload when back online");
      }catch(_){}
    } else toast(msg, true);
  }
}
function saveProjJson(){
  dl(new Blob([JSON.stringify(serialize(),null,2)],{type:"application/json"}),
    \`\${(S.prefix||"site")}_capture_draft.json\`);
}
function dl(blob,name){const a=el("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);}
`

// Fix toast(true) - original toast doesn't take error flag; leave as is with second arg unused or extend toast
// Use function replacer — replacement strings treat $& as "matched text"
if (!html.includes(oldExport.slice(0, 80))) {
  console.warn('WARN: old EXPORT block not found exactly; trying looser match')
}
html = html.replace(oldExport, () => newExport)
if (html.includes('async function exportZip')) {
  // Fallback: remove leftover exportZip if partial match left it
  html = html.replace(/async function exportZip\(\)\{[\s\S]*?^function dl\(blob,name\)\{[^}]+\}\n/m, '')
}

// restore() — include meta
html = html.replace(
  `async function restore(proj){
  S.building=proj.building||null;S.prefix=proj.prefix||"SITE";S.next=proj.next||1;
  S.opt=Object.assign(S.opt,proj.opt||{});S.pageCount=proj.pageCount||1;
  S.pins=(proj.pins||[]).map(p=>({...p}));
  if(S.building){$("#bldgA").textContent=S.building.address;$("#bldgB").textContent=\`\${S.building.portfolio.replace(" Business Park","")} · BU \${S.building.bu}\`;}
  $("#setPrefix").value=S.prefix;$("#setNext").value=S.next;updateEg();syncToggles();
  refreshPins();save();
}`,
  `async function restore(proj){
  S.building=proj.building||null;S.prefix=proj.prefix||"SITE";S.next=proj.next||1;
  S.opt=Object.assign(S.opt,proj.opt||{});S.pageCount=proj.pageCount||1;
  S.meta=Object.assign(S.meta, proj.meta||{});
  if(S.building && !S.meta.address) S.meta.address=S.building.address;
  S.completed=!!proj.completed;
  S.pins=(proj.pins||[]).map(p=>({...p}));
  // Migrate old prefix-01 names toward "prefix (n)" when no custom rename
  S.pins.forEach(p=>{
    if(p.seq!=null && /^\\d+[\\w-]*-\\d+$/.test(String(p.name||""))) p.name=pinName(p.seq);
  });
  if(S.building){$("#bldgA").textContent=S.building.address;$("#bldgB").textContent=\`\${S.building.portfolio.replace(" Business Park","")} · BU \${S.building.bu}\`;}
  else if(S.meta.address){$("#bldgA").textContent=S.meta.address;$("#bldgB").textContent=S.meta.name||"Capture project";}
  $("#setPrefix").value=S.prefix;$("#setNext").value=S.next;updateEg();syncToggles();
  refreshPins();save();
}`,
)

// boot + home wiring — replace boot and end of wiring
html = html.replace(
  `async function boot(){
  await idb();
  const proj=await idbGet("kv","project");
  if(proj){await restore(proj);
    const pdf=await idbGet("kv","pdf");
    if(pdf&&pdf.bytes){await openPdfBytes(pdf.bytes instanceof Uint8Array?pdf.bytes:new Uint8Array(pdf.bytes),pdf.name);}
  }
  updateActionBar();syncToggles();
  if(!window.pdfjsLib||!window.JSZip)toast("Libraries didn't load — reconnect to internet once, then reopen");
}`,
  `function showHome(){
  $("#home").classList.remove("hidden");
  $("#app").style.display="none";
  updateHomeResume();
  if(location.protocol==="https:"){
    $("#homeMixedNote").innerHTML="<b>On this HTTPS site:</b> use ATTACH for photos. SNAP needs a local HTTP Capture page on camera Wi‑Fi.";
  } else {
    $("#homeMixedNote").textContent="HTTP mode — SNAP to the X5 is available when you join camera Wi‑Fi.";
  }
}
function showApp(){
  $("#home").classList.add("hidden");
  $("#app").style.display="flex";
  if(location.protocol==="https:") $("#mixedBanner").classList.add("show");
  else $("#mixedBanner").classList.remove("show");
}
async function updateHomeResume(){
  const proj=await idbGet("kv","project");
  const sub=$("#homeResumeSub");
  if(proj&&(proj.pins&&proj.pins.length||proj.meta&&proj.meta.name||proj.building)){
    const n=(proj.pins||[]).length, shot=(proj.pins||[]).filter(p=>p.photoId).length;
    const label=(proj.meta&&proj.meta.name)||(proj.building&&proj.building.address)||"Draft";
    sub.textContent=\`\${label} · \${shot}/\${n} photos\`;
    $("#homeResume").disabled=false;
  } else {
    sub.textContent="No draft on this phone yet";
  }
}
async function boot(){
  await idb();
  updateActionBar();syncToggles();
  const forceCapture=/(?:^|[?&])capture=1(?:&|$)/.test(location.search);
  const proj=await idbGet("kv","project");
  if(forceCapture && proj){
    await restore(proj);
    const pdf=await idbGet("kv","pdf");
    if(pdf&&pdf.bytes){await openPdfBytes(pdf.bytes instanceof Uint8Array?pdf.bytes:new Uint8Array(pdf.bytes),pdf.name);}
    showApp();
  } else {
    showHome();
    // Warm restore into memory when resuming later
    if(proj){ /* keep in IDB only until Resume */ }
  }
  if(!window.pdfjsLib||!window.JSZip)toast("Libraries didn't load — reconnect to internet once, then reopen");
  window.addEventListener("online", ()=>{ flushUploadQueue(); refreshAuthNote(); });
  try{ await flushUploadQueue(); }catch(_){}
}`,
)

// Wire new buttons — replace exportZip wiring
html = html.replace(
  `$("#exportZip").onclick=exportZip;
$("#saveProj").onclick=saveProjJson;
$("#loadProj").onclick=()=>$("#projFile").click();
$("#projFile").onchange=e=>{const f=e.target.files[0];if(f){loadProjectFile(f);closeSheet("#menuSheet");}e.target.value="";};
$("#resetProj").onclick=async()=>{if(!confirm("Reset everything on this device?"))return;
  await idbClear("photos");await idbDel("kv","project");await idbDel("kv","pdf");location.reload();};

window.addEventListener("resize",()=>{if(S.pdfDoc){applyTransform();scheduleRerender();}});
boot();`,
  `$("#completeBtn").onclick=()=>openCompleteSheet();
$("#completeMenuBtn").onclick=()=>{closeSheet("#menuSheet");openCompleteSheet();};
$("#btnUploadCloud").onclick=()=>uploadToCloud();
$("#btnSaveUsb").onclick=()=>saveForUsb();
$("#btnSaveTourJson").onclick=()=>saveTourJsonOnly();
$("#saveProj").onclick=saveProjJson;
$("#loadProj").onclick=()=>$("#projFile").click();
$("#projFile").onchange=e=>{const f=e.target.files[0];if(f){loadProjectFile(f);closeSheet("#menuSheet");showApp();}e.target.value="";};
$("#resetProj").onclick=async()=>{if(!confirm("Reset everything on this device?"))return;
  await idbClear("photos");await idbDel("kv","project");await idbDel("kv","pdf");await idbDel("kv","uploadQueue");location.reload();};
$("#homeBackBtn").onclick=()=>{closeSheet("#menuSheet");showHome();};
$("#openViewerBtn").onclick=()=>{location.href="/";};

$("#homeNew").onclick=()=>{
  $("#metaName").value=S.meta.name||"";
  $("#metaTenant").value=S.meta.tenant||"";
  $("#metaCreator").value=S.meta.creator||"";
  $("#metaAddrNote").textContent=S.meta.address||"Required for cloud folder naming";
  openSheet("#projSheet");
};
$("#homeResume").onclick=async()=>{
  const proj=await idbGet("kv","project");
  if(!proj){toast("No draft found");return;}
  await restore(proj);
  const pdf=await idbGet("kv","pdf");
  if(pdf&&pdf.bytes){await openPdfBytes(pdf.bytes instanceof Uint8Array?pdf.bytes:new Uint8Array(pdf.bytes),pdf.name);}
  showApp(); toast("Draft resumed");
};
$("#homeViewer").onclick=()=>{location.href="/";};
$("#metaPickBldg").onclick=()=>{closeSheet("#projSheet");renderPorts();renderBldgList();openSheet("#bldgSheet");};
$("#metaStart").onclick=async()=>{
  const name=$("#metaName").value.trim();
  if(!name){toast("Enter a project name");return;}
  if(!S.building && !S.meta.address){toast("Pick a building address first");return;}
  // Fresh draft
  await idbClear("photos");
  S.pins=[]; S.selPin=null; S.pdfDoc=null; S.pdfBytes=null; S.pdfName=null;
  S.meta.name=name;
  S.meta.tenant=$("#metaTenant").value.trim();
  S.meta.creator=$("#metaCreator").value.trim();
  S.meta.created=new Date().toISOString();
  S.completed=false;
  if(S.building){
    S.meta.address=S.building.address;
    S.prefix=S.building.prefix||S.prefix||"SITE";
  }
  $("#bldgA").textContent=S.meta.address||"Select building";
  $("#bldgB").textContent=S.meta.name;
  $("#hint").style.display="";
  $("#pinLayer").innerHTML="";
  closeSheet("#projSheet");
  save(); showApp();
  toast("Project created — open a floor plan PDF");
  openSheet("#menuSheet");
};

// Re-open project sheet after building pick when creating
const _origPick=pickBuilding;
pickBuilding=function(b){
  _origPick(b);
  if($("#home").classList.contains("hidden")===false){
    // still on home — ignore
  }
  if($("#metaName") && !$("#metaName").value) $("#metaName").value=(b.prefix||"")+" Capture";
};

window.addEventListener("resize",()=>{if(S.pdfDoc){applyTransform();scheduleRerender();}});
boot();`,
)

// Fix toast signature for second boolean (ignore)
html = html.replace(
  `function toast(m,ms=1900){const t=$("#toast");t.textContent=m;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),ms);}`,
  `function toast(m,msOrErr){const ms=typeof msOrErr==="number"?msOrErr:1900;const t=$("#toast");t.textContent=m;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),ms);}`,
)

fs.writeFileSync(capturePath, html, 'utf8')
console.log('Wrote', capturePath, '(' + html.length + ' bytes)')
