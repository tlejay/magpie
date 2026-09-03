// Local-only harness: makes a QR appear after a delay, at a size you choose,
// so the extension can be exercised without booking a real webinar.
const CODES = [
  { src: 'qr-a.png', text: 'https://forms.gle/MagpieTestA', note: 'ควรเตือน' },
  { src: 'qr-b.png', text: 'https://docs.google.com/forms/d/e/MagpieTestB/viewform', note: 'ควรเตือน' },
  // Blocked by the default deny-list — this is the real-world false positive:
  // a speaker's LINE add-friend QR on their intro slide.
  { src: 'qr-c.png', text: 'https://lin.ee/p9365Wh', note: 'ควรถูกกรองทิ้ง (อยู่ใน blacklist)' },
];

const $ = (id) => document.getElementById(id);
let which = 0;
let timer = null;

$('size').addEventListener('input', () => {
  const v = $('size').value;
  $('qr').width = Number(v);
  $('sizeLabel').textContent = `${v}px`;
});

$('dark').addEventListener('change', () => {
  document.body.classList.toggle('dark', $('dark').checked);
});

$('start').addEventListener('click', () => {
  clearInterval(timer);
  $('qrWrap').classList.remove('show');
  let left = Number($('delay').value) || 0;
  render(left);
  timer = setInterval(() => {
    left -= 1;
    render(left);
    if (left <= 0) {
      clearInterval(timer);
      show();
    }
  }, 1000);
  if (left <= 0) { clearInterval(timer); show(); }
});

$('swap').addEventListener('click', () => {
  which = (which + 1) % CODES.length;
  apply();
  show();
});

$('hide').addEventListener('click', () => {
  clearInterval(timer);
  $('qrWrap').classList.remove('show');
  $('countdown').textContent = 'ซ่อนอยู่';
});

function render(left) {
  $('countdown').textContent = left > 0 ? `${left}` : 'โผล่แล้ว!';
}

function show() {
  apply();
  $('qrWrap').classList.add('show');
  $('countdown').textContent = 'QR โผล่แล้ว — รอ extension จับ';
}

function apply() {
  const code = CODES[which];
  $('qr').src = code.src;
  $('payload').textContent = `${code.text}   —   ${code.note}`;
  $('qr').width = Number($('size').value);
}
