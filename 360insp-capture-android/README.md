# QR360 Capture — Android (Capacitor)

Native Android shell around Capture for Insta360 X5 field work.

**Open this project in Android Studio** (ASCII path — required):

`C:\Users\Robert\Projects\insp-capture-android\android`

## Field workflow (pin ↔ camera picture #)

1. Load floor plan, drop pins in shoot order.
2. **Camera** panel → **Connect BLE remote** (phone advertises as GPS remote).
3. On the X5, connect / allow **GPS Remote** (or keep Bluetooth on so it links).
4. Select a pin → **SNAP + LOG** — app sends BLE shutter and records `pin → camera #N`.
5. If BLE didn’t fire, press the camera shutter once anyway — the log still matches by sequence.
6. **Export shoot log** (`.zip` with `shoot-log.json` + plan + draft).
7. On PC: download X5 photos, open **`insp-sync-shots.html`**, load shoot log + photos → **Build .insp360**.

PC sync tool:

`C:\Users\Robert\Projects\QR-360-Inspections\QR-360-Inspections\insp-sync-shots.html`

## Sync Capture UI from the QR360 repo

```powershell
cd C:\Users\Robert\Projects\insp-capture-android
npm install
npm run cap:sync
```

Then in Android Studio: **Run** ▶ on your phone (needed after BLE plugin changes).

## Modes (Menu → Capture mode)

| Mode | What SNAP does |
|------|----------------|
| **Field (BLE + log)** | Shutter over BLE + log picture # (no download) |
| **Wi‑Fi SNAP** | OSC takePicture + download JPG (camera Wi‑Fi) |
| **Import JPG** | Pick stitched photo from phone |
