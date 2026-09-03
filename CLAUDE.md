# CLAUDE.md — 125 ZOOM (Zoom QR Watcher)

Chrome extension (Manifest V3) ที่เฝ้าแท็บ Zoom web client แล้วแจ้งเตือนเมื่อเจอ QR Code
รายละเอียดการใช้งานอยู่ใน `README.md` — ไฟล์นี้เก็บเฉพาะสิ่งที่คนแก้โค้ดต้องรู้

## Stack

**Vanilla JavaScript ล้วน ไม่มี build step ไม่มี npm ไม่มี node_modules**
แก้ไฟล์ → กด Reload ที่ `chrome://extensions` → เห็นผลทันที
อย่าเพิ่ม TypeScript / bundler / framework เข้ามาโดยไม่ถาม Tle ก่อน — extension ขนาดนี้ไม่คุ้ม

## สถาปัตยกรรม — ทำไมถึงต้องมี offscreen document

MV3 ฆ่า service worker ทิ้งเมื่อ idle ~30 วินาที ถ้าเอาลูปสแกนไว้ใน service worker
มอนิเตอร์จะ **ตายเงียบ ๆ กลางคาบ** ซึ่งคือ failure mode ที่แย่ที่สุดของโปรเจคนี้
(Tle คิดว่ามียามเฝ้าอยู่ แต่จริง ๆ ยามหลับไปแล้ว)

MediaStream + ลูปสแกนจึงอยู่ใน **offscreen document** ซึ่ง Chrome ยอมให้เปิดค้างเพราะถือ media อยู่

```
popup.js ──(user gesture: getMediaStreamId)──► service-worker.js
                                                    │ createDocument
                                                    ▼
                                              offscreen.js
                                          (holds stream, scan loop)
                                                    │ QR_FOUND / HEARTBEAT
                                                    ▼
                                              service-worker.js
                                   (dedup → notification → Discord → log)
```

### กฎที่ห้ามพัง

1. **`chrome.tabCapture.getMediaStreamId()` ต้องเรียกจาก popup** ภายใน user gesture เท่านั้น
   ย้ายไป service worker แล้วจะได้ error หรือ stream id ที่ใช้ไม่ได้
2. **ห้ามขอ `audio: true` ใน getUserMedia** — tab capture ที่ขอเสียงจะ **mute เสียง webinar**
   ซึ่งทำให้ทั้งเครื่องมือไร้ความหมาย เราต้องการแค่ภาพ
3. **ห้ามเอาลูปสแกนกลับไปไว้ใน service worker** (ดูเหตุผลข้างบน)
4. **ห้าม hardcode webhook URL** ลงไฟล์ที่ commit — อ่านจาก `src/config.local.js` ที่ gitignored ไว้
5. **ห้ามใช้ inline `<script>` หรือ `onclick=`** — MV3 CSP บล็อก ต้องแยกเป็นไฟล์ `.js` เสมอ
6. **ห้ามโหลด script จาก CDN ตอน runtime** — MV3 ห้าม ทุกอย่างต้องอยู่ใน `lib/`

## กลยุทธ์การอ่าน QR (`src/shared/qr.js`)

3 ชั้น เรียงตามราคา — ไม่มี AI เกี่ยวข้องเลย:

| ชั้น | ทำอะไร | จับเคสไหน |
|---|---|---|
| 1 | อ่านทั้งเฟรมรวดเดียว | QR ขนาดปกติ — จบที่นี่ 90%+ |
| 2 | หั่น 3×3 ซ้อนขอบ 15% ขยาย 2 เท่า | QR เล็กมุมสไลด์ที่ชั้น 1 มองข้าม |
| 3 | กลับสีทั้งเฟรม อ่านอีกรอบ | สไลด์พื้นดำ QR ขาว |

ตัวเลข GRID / OVERLAP / UPSCALE อยู่บนสุดของไฟล์ ปรับได้ถ้าเจอเคสที่จับไม่ได้

**ผลทดสอบที่ยืนยันแล้ว** (jsQR บนสไลด์จำลอง 1280×720 บีบอัด q30): ชั้น 1 อ่านได้ถึง QR ขนาด 90px
ที่ 80px ชั้น 1 พลาดแต่ชั้น 2 เก็บได้ · ที่ 70px ลงไปข้อมูลหายถาวร ขยายยังไงก็ไม่กลับมา
→ ถ้าจะปรับปรุงการจับ ให้ไปเพิ่ม **ความละเอียดของภาพที่จับ** ไม่ใช่ไปเพิ่มชั้นการอ่าน

## จุดที่พังบ่อยและวิธีตรวจ

| อาการ | ดูที่ |
|---|---|
| กดเริ่มแล้วไม่มีอะไรเกิด | `chrome://extensions` → Service worker → Console |
| ลูปสแกนหยุดเอง | `chrome://extensions` → Inspect views: offscreen.html → Console |
| Discord ไม่เข้า | Options → ปุ่ม "ทดสอบส่งเข้า Discord" (จะโชว์ HTTP status จริง) |
| เตือนซ้ำไม่หยุด | ตรวจค่า cooldown · หรือ payload ของ QR เปลี่ยนทุกครั้ง (บาง QR ฝัง timestamp) |
| ไม่เตือนเลยทั้งที่เห็น QR | ลด interval + ขยายหน้าต่าง Zoom ก่อน แล้วค่อยไปแตะ tiling |

`sendToOffscreenReady()` ใน service worker มี retry ไว้แล้ว เพราะ `createDocument()` resolve
ก่อนที่ `offscreen.js` จะ register listener ได้ทัน — ข้อความแรกเคยหายเพราะเหตุนี้

## ทดสอบ

หน้าทดสอบอยู่ที่ `test/qr-test.html` (เปิดจากปุ่มใน popup) — จำลอง QR โผล่กลางคัน ปรับขนาดได้ สลับ payload ได้
ขั้นตอนทดสอบเต็มอยู่ใน README หัวข้อ "ทดสอบก่อนใช้งานจริง"

QR ทดสอบ (`test/qr-a.png`, `qr-b.png`) สร้างด้วย `qrencode` ถ้าจะสร้างใหม่:
```bash
qrencode -o test/qr-a.png -s 12 -m 2 "https://forms.gle/ZoomQRWatcherTestA"
```

## Git

- private repo ของ Tle · commit + push ได้เลยหลังทำงานเสร็จแต่ละก้อน (ตาม root CLAUDE.md)
- **ก่อน `git add` ทุกครั้ง** เช็คว่า `src/config.local.js` ยังถูก ignore อยู่:
  ```bash
  git check-ignore -v src/config.local.js   # ต้องมี output
  git ls-files | grep -i 'config.local'     # ต้องไม่มี output
  ```
