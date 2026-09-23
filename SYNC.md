# SYNC.md — Magpie

อ่านไฟล์นี้ก่อนเริ่ม session ใหม่ จะได้ทำต่อจากรอบก่อนได้โดยไม่ต้องไล่บทสนทนาเก่า
ถ้าไฟล์นี้ขัดกับ GitHub issue ให้เชื่อ issue — ไฟล์นี้อัปเดตแค่ตอนปิด session

**อัปเดตล่าสุด:** 23 ก.ย. 2569 · build `1.3.1`

## ตอนนี้อยู่ตรงไหน

extension ใช้งานได้ครบ 3 อย่าง (QR · เสียง · สไลด์) ในการประชุมจริง (Zoom 1920×1080)
รอบล่าสุดเจอว่า "ห้อง Discord เงียบ" แต่จริง ๆ แล้วไม่ใช่บั๊ก — ตอนนั้นไม่มีอะไรตั้งให้ส่ง

**เป้าหมายของ Tle ในโหมดสไลด์:** ส่งภาพเข้า Discord ทันทีทุกครั้งที่สไลด์เปลี่ยน
โค้ดทำได้แล้ว เหลือแค่ตั้งค่าในเครื่อง Tle

## รอบล่าสุดทำอะไรไป (10 ก.ย.)

- `690f939` ส่งสไลด์เข้า Discord เป็น **ค่าเริ่มต้น** (`slidesToDiscord: true`)
- `690f939` popup ขึ้นแถบเตือน "ไม่มีอะไรส่งเข้า Discord" ระหว่างอัด ถ้า QR ไม่ได้รันและสไลด์ไม่ได้ส่ง
- README แก้ให้ตรงกับค่าเริ่มต้นใหม่

## รอบ 23 ก.ย. — popup เปิดช้า (แก้แล้ว)

อาการ: กดไอคอนแล้ว popup ขึ้นช้าเหมือน cold start บางครั้ง · วัดจากเครื่องจริง (Profile 1) เจอ
IndexedDB **218 MB** และ `chrome.storage.local` log **2.2 MB** จากการเขียนคีย์ `state` ซ้ำ 3,017 ครั้ง

แก้ไป 3 อย่าง:

1. popup ไม่เปิด IndexedDB ตอนเปิดอีกแล้ว — service worker เขียนสรุป session ลง `lastSession`
   ใน `chrome.storage.local` ตอนหยุด (`cacheSessionSummary()`) · โปรไฟล์เก่าที่ยังไม่มีสรุป
   จะไปอ่าน IDB **หลังวาดจอเสร็จ** ครั้งเดียวแล้วเขียนสรุปเก็บไว้
2. `db.js` · `export.js` · `fflate` ย้ายไป `import()` ตอนกดปุ่มดาวน์โหลด · ลบ `<script fflate>` ออกจาก popup.html
3. อ่าน storage รอบเดียวด้วย `getPopupSnapshot()` (เดิม 4 ครั้งแยกกัน) แล้ววาดจอจาก snapshot นั้น

ยืนยันแล้วด้วย harness stub + headless Chrome: เปิด popup แล้ว `indexedDB.open` ไม่ถูกเรียก
และ fflate ไม่ถูกโหลด · โปรไฟล์ที่ไม่มีสรุปเรียก IDB จริงตามที่ตั้งใจ

ทำต่ออีก 2 ข้อในวันเดียวกัน:

4. **เขียน `state` น้อยลง 6 เท่า** — heartbeat ทุก 10 วิ ไม่เขียนลง storage แล้ว
   popup ที่เปิดอยู่รับเลขสดผ่าน port `magpie-live` (ต่อเฉพาะตอน monitoring เท่านั้น
   เพราะการต่อ port จะปลุก service worker — ซึ่งคือสิ่งที่เพิ่งแก้ไป) · storage เก็บ checkpoint นาทีละครั้ง
   · `setState()` ข้ามการเขียนที่ไม่มีอะไรเปลี่ยนด้วย · วัดแล้ว: ประชุม 2 ชม. 720 → 120 ครั้ง
   · ผลพลอยได้: แก้บั๊กที่ heartbeat ปั๊ม `lastScanAt` ทุกครั้งจนการตรวจ "Magpie ค้าง" ไม่มีวันทำงาน
5. **offscreen โหลด lib เท่าที่ใช้** — ลบ 3 script tag ออกจาก `offscreen.html` ใช้ `loadLib()` แทน
   lame โหลดเมื่ออัดเสียง · jsqr โหลดเฉพาะเครื่องที่ไม่มี BarcodeDetector (`createScanner({ loadFallback })`)
   · fflate โหลดตอน EXPORT_ZIP · ยืนยันด้วย harness: offscreen บูตแล้วไม่มี lib ตัวไหนถูกโหลดเลย

ทดสอบข้อ 4-5 ไว้ที่ (harness อยู่ใน scratchpad ของ session นั้น ถ้าหายให้เขียนใหม่ได้จากคำอธิบายนี้):
รัน service-worker ใน node ด้วย chrome stub ยิง heartbeat 720 ครั้งแล้วนับจำนวน `storage.local.set`
· headless Chrome เปิด popup/offscreen พร้อม stub เพื่อดูว่าอะไรถูกโหลดจริง

## รอบ 23 ก.ย. (ต่อ) — ภาพ QR เข้า ZIP แล้ว

Tle ถามว่าเอาภาพที่แคปเจอร์ได้ใส่ ZIP ด้วยได้ไหม — สไลด์อยู่ใน `slides/` อยู่แล้ว
แต่ภาพเฟรมตอนเจอ QR เดิมสร้างขึ้นเพื่อส่ง Discord แล้วทิ้ง ตอนนี้เก็บลงแถว `qrHits`
แล้วออกมาเป็น `qr/001_00-02-05.jpg` ใน ZIP พร้อมอ้างใน `timeline.md` และ `session.json`

- offscreen สร้างภาพ 1280px เสมอ (เดิมสร้างเฉพาะตอนเปิด "แนบภาพไป Discord")
  · การตัดสินใจว่าจะแนบไป Discord ไหมยังอยู่ที่ service worker เหมือนเดิม
- เก็บเฉพาะ QR ที่ผ่าน cooldown/filter แล้วจริง ๆ (ในลูป `toAlert`) แปลง data URL → Blob ครั้งเดียวต่อเฟรม
- แถวเก่าที่ไม่มีภาพ → `file: null` ไม่พัง

## งานค้าง

| ใคร | issue | เรื่อง |
|---|---|---|
| Tle | [tle-personal#67](https://github.com/tlejay/tle-personal/issues/67) | Reload + ติ๊กส่งสไลด์ + เปลี่ยน webhook เป็นห้องที่ถูก + ทดสอบส่ง |
| Tle (รอเคาะ) | [magpie#1](https://github.com/tlejay/magpie/issues/1) | ROI picker — เลือกพื้นที่จอที่ใช้ตรวจสไลด์ |
| Claude | [magpie#2](https://github.com/tlejay/magpie/issues/2) | ทดสอบแถบเตือน + ค่าเริ่มต้นใน popup จริง (ตอนนี้ตรวจแค่ syntax) |

## เรื่องที่รู้แล้ว อย่าไล่ใหม่

- **อะไรส่งเข้า Discord บ้าง:** QR (เมื่อเปิดเฝ้าหา QR) กับสไลด์ (เมื่อ `slidesToDiscord`) — **เสียงไม่เคยออกจากเครื่อง**
- **เปลี่ยนค่าเริ่มต้นไม่มีผลกับเครื่องที่ติดตั้งไว้แล้ว** — `saveSettings()` เขียน settings ทั้งก้อนลง `chrome.storage`
  ค่าเก่าจึงถูกจำไว้ ต้องไปแก้ในหน้าตั้งค่าเอง
- **`src/config.local.js` ใช้แค่ตอนติดตั้งครั้งแรก** (`seedWebhookFromLocalConfig()` ข้ามถ้ามี `webhookUrl` แล้ว)
  webhook ที่ใช้จริงอยู่ในหน้าตั้งค่า — แก้ไฟล์นี้ไม่ช่วยเครื่องที่ติดตั้งแล้ว
  ตอนนี้ไฟล์นี้ชี้ไปคนละห้องกับที่ Tle ต้องการ (ดู tle-personal#67)
- **เปิด/ปิดเครื่องมือ (QR/เสียง/สไลด์) ต้องหยุดแล้วเริ่มใหม่** — `state.features` จึงตรงกับที่รันจริงเสมอ
  ส่วนค่าอื่น (threshold, `slidesToDiscord`) ส่งเข้า offscreen ได้กลางทางผ่าน `UPDATE_CONFIG`
- ช่อง "ภาพ" ใน popup (เช่น `1920×1080`) บอกได้ว่าแท็บส่งภาพมาไหม — `0×0` = ไม่ได้ภาพเลย

## เริ่ม session หน้า

```bash
git pull
gh issue list --repo tlejay/magpie --state open
gh issue view 67 --repo tlejay/tle-personal      # Tle ตั้งค่าเสร็จหรือยัง
```

ถ้า Tle บอกว่าตั้งค่าแล้วแต่ยังไม่เข้า Discord → ขอแคป popup ก่อน แล้วดูแถบเตือนกับช่อง "ส่งแล้ว"
