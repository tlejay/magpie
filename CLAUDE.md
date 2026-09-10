# CLAUDE.md — Magpie

Chrome extension (Manifest V3) เก็บของจากการประชุมออนไลน์: QR Code, เสียง, สไลด์
วิธีใช้อยู่ใน `README.md` ไฟล์นี้เก็บเฉพาะสิ่งที่คนแก้โค้ดต้องรู้
**เริ่ม session ใหม่ให้อ่าน `SYNC.md` ก่อน** — งานค้างและสิ่งที่รอบก่อนค้นเจอแล้ว

## Stack

**Vanilla JavaScript ล้วน ไม่มี build step ไม่มี npm ไม่มี node_modules**
แก้ไฟล์ → กด Reload ที่ `chrome://extensions` → เห็นผลทันที
อย่าเพิ่ม TypeScript / bundler / framework โดยไม่ถาม Tle ก่อน

`lib/` เก็บ dependency แบบ vendored (`jsqr.js`, `fflate.min.js`) เพราะ **MV3 ห้ามโหลด script จากเน็ตตอน runtime**

## สถาปัตยกรรม

`offscreen.js` คือ **capture hub** — จับ stream ครั้งเดียวแล้วแจกให้ตัวประมวลผล 3 ตัวที่มีจังหวะต่างกัน

```
popup ─(getMediaStreamId ใน user gesture)→ service-worker ─(createDocument)→ offscreen
                                                                              ├─ video → QR (60 วิ)
                                                                              ├─ video → slides (3 วิ)
                                                                              └─ audio → passthrough + recorder
```

### กฎเหล็ก — ห้ามพัง

1. **ห้ามย้ายลูปสแกนหรือ MediaRecorder ไปไว้ใน service worker** — MV3 ฆ่ามันตอน idle
   เดิมพันตอนนี้คือ "เสียการอัดทั้งประชุม" ไม่ใช่แค่พลาด QR หนึ่งอัน
2. **ขอ audio จาก tabCapture เมื่อไหร่ Chrome จะ mute แท็บทันที** ต้องต่อ
   `tabSource → passthroughGain → ctx.destination` กลับเสมอ ไม่งั้นประชุมเงียบทั้งงาน
   → ถ้าผู้ใช้ไม่เปิดการอัดเสียง **ห้ามขอ audio ตั้งแต่แรก**
3. **ห้ามต่อไมค์เข้า `ctx.destination`** เด็ดขาด — จะได้ยินเสียงตัวเองย้อนกลับ
   ไมค์ต่อเข้า MediaStreamDestination ที่ป้อน MediaRecorder อย่างเดียว
   (โหมด `mixed` ใช้ destination เดียวร่วมกับแท็บ · โหมด `separate` แยก destination กันคนละตัว)
4. **`chrome.tabCapture.getMediaStreamId()` ต้องเรียกจาก popup** ภายใน user gesture
   ย้ายไป service worker แล้วจะได้ stream id ที่ใช้ไม่ได้
5. **ห้าม hardcode webhook URL** — อ่านจาก `src/config.local.js` ที่ gitignored ไว้
6. **ห้ามใช้ inline `<script>` หรือ `onclick=`** — MV3 CSP บล็อก
7. **แต่ละ analyzer ต้องมี canvas ของตัวเอง** — QR decode เป็น async ถ้าใช้ canvas ร่วมกับ
   slide check จะอ่านพิกเซลทับกัน
8. **ห้ามเดาแทนผู้ใช้ในข้อความแจ้งเตือน** — เคยเขียนว่า "เปิดแบบสอบถาม" แล้วผิดตั้งแต่ครั้งแรก
   ที่ยิงจริง (ปลายทางเป็นลิงก์ LINE) บอกแค่สิ่งที่รู้จริง: เจอ QR + โดเมนคืออะไร

## ตัวเลขที่วัดมาแล้ว (อย่าเดาใหม่)

**QR** (jsQR ตัวสำรอง · สไลด์จำลองบีบอัดแบบที่ประชุมส่งจริง)

| ภาพที่จับได้ | ขนาด QR | ผล |
|---|---|---|
| 1920×1080 q55 | ลงถึง 64px | ชั้น 1 ผ่าน |
| 1280×720 q30 | 90px | ชั้น 1 ผ่าน |
| 1280×720 q30 | 80px | ชั้น 1 พลาด **ชั้น 2 (tiling) เก็บได้** |
| 1280×720 q30 | ≤70px | ข้อมูลหายถาวร |

ต่ำกว่า ~1.5 พิกเซลต่อช่อง QR = จบ ขยายทีหลังไม่ช่วย
→ อยากให้จับดีขึ้น ให้ไปเพิ่ม **ความละเอียดของภาพที่จับ** ไม่ใช่เพิ่มชั้นการอ่าน

**สไลด์** (สไลด์จำลอง + กล่องกล้องที่ขยับตลอด)

| สถานการณ์ | สัดส่วนพื้นที่ที่เปลี่ยน | ผล |
|---|---|---|
| กล้องขยับอย่างเดียว | 2.1–2.8% | ไม่จับ |
| เฟรมกลาง fade | 47.9% | รอ ไม่บันทึก |
| เปลี่ยนสไลด์จริง | 94.4–96.5% | บันทึก |

ช่องว่างระหว่าง noise กับ signal ราว 35 เท่า — threshold 20% จึงมีที่เหลือเยอะทั้งสองทาง
**นี่คือเหตุผลที่วัดเป็น "สัดส่วนช่องที่เปลี่ยน" ไม่ใช่ผลต่างพิกเซลรวม** ถ้าเปลี่ยนไปวัดแบบหลัง
กล้องวิทยากรจะทำให้จับรัวทันที

## จุดที่พังบ่อยและวิธีตรวจ

| อาการ | ดูที่ |
|---|---|
| กดเริ่มแล้วไม่มีอะไรเกิด | `chrome://extensions` → Service worker → Console |
| ลูปหยุดเอง / การอัดหาย | Inspect views: `offscreen.html` → Console |
| **เสียงประชุมเงียบ** | passthrough ไม่ได้ต่อ — ดูกฎข้อ 2 |
| ได้ยินเสียงตัวเองย้อน | ไมค์ต่อเข้า `ctx.destination` — ดูกฎข้อ 3 |
| Discord ไม่เข้า | Options → ปุ่มทดสอบส่ง (โชว์ HTTP status จริง) |
| สไลด์จับรัว | เพิ่ม `changeThreshold` หรือ `blockDelta` |
| สไลด์ไม่จับเลย | ลด `changeThreshold` · เช็คว่าหน้าต่างใหญ่พอ |

`sendToOffscreenReady()` มี retry อยู่แล้ว เพราะ `createDocument()` resolve ก่อนที่ `offscreen.js`
จะ register listener ทัน — ข้อความแรกเคยหายเพราะเหตุนี้

## ทดสอบ

```bash
node /tmp/zqrtest/t2.mjs      # blacklist + ลำดับการตัดสิน (ถ้ายังมีไฟล์อยู่)
node /tmp/slidetest/run.mjs   # ตัวตรวจสไลด์กับภาพจริง
```

หน้าทดสอบในตัว (เปิดจาก popup): `test/qr-test.html` · `test/slide-test.html`
สร้าง QR ทดสอบใหม่: `qrencode -o test/qr-a.png -s 12 -m 2 "https://…"`

เรนเดอร์ UI ตรวจ layout โดยไม่ต้องโหลด extension: stub ข้อมูลลง HTML แล้ว
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=out.png file://…`

## ⚠️ อัป build stamp ทุกครั้งที่จะ push

popup กับหน้า options โชว์ `version_name` จาก manifest เพื่อให้ตอบได้ว่า
"Reload ติดหรือยัง" โดยไม่ต้องเดา — **ถ้าไม่อัปเลข ป้ายนั้นจะโกหก** และเสียเวลาทดสอบทั้งรอบ

```bash
python3 - <<'EOF'
import json, datetime
m = json.load(open('manifest.json', encoding='utf-8'))
m['version_name'] = f"{m['version']} · build {datetime.datetime.now():%m%d-%H%M}"
json.dump(m, open('manifest.json','w',encoding='utf-8'), indent=2, ensure_ascii=False)
open('manifest.json','a').write('\n')
print(m['version_name'])
EOF
```

`version` ต้องเป็นตัวเลขคั่นจุดเท่านั้น (กฎของ Chrome) ส่วน `version_name` ใส่ข้อความอะไรก็ได้
เพิ่ม `version` เองเมื่อมีฟีเจอร์ใหม่จริง ๆ ส่วน build stamp อัปทุก push

## Git

- public repo `github.com/tlejay/magpie` · commit + push ได้เลยหลังทำงานเสร็จแต่ละก้อน
- **ก่อน `git add` ทุกครั้ง** เช็คว่า secret ไม่หลุด:
  ```bash
  git ls-files | grep -i 'config.local'          # ต้องไม่มี output
  git check-ignore -v src/config.local.js        # ต้องมี output
  git grep -nI 'discord.com/api/webhooks/[0-9]' -- $(git ls-files)   # ต้องไม่มี output
  ```
