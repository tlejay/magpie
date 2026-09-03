// Simulates a presenter's shared screen: slides that change on demand, plus a
// webcam tile that never stops moving. The whole point of the slide detector is
// to react to the first and ignore the second, so both must be present here.

const SLIDES = [
  { bg: '#ffffff', ink: '#1a1a2e', accent: '#c7d7ff', title: 'บทนำ' },
  { bg: '#f7f3ec', ink: '#4a2f1a', accent: '#d9b382', title: 'ที่มาของปัญหา' },
  { bg: '#eef6f1', ink: '#12452c', accent: '#a8d5bd', title: 'แนวทางแก้ไข' },
  { bg: '#1a1a2e', ink: '#f0f0f5', accent: '#5a5a8e', title: 'ตัวเลขที่ได้' },
  { bg: '#fdf0f0', ink: '#5c1f1f', accent: '#e8b4b4', title: 'ข้อควรระวัง' },
  { bg: '#f4f4f4', ink: '#222222', accent: '#bbbbbb', title: 'สรุป' },
];

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const hud = $('hud');

let index = 0;
let autoTimer = null;

const nodes = SLIDES.map((s, i) => {
  const el = document.createElement('div');
  el.className = 'slide';
  el.style.background = s.bg;
  el.style.color = s.ink;

  const h2 = document.createElement('h2');
  h2.textContent = `${i + 1}. ${s.title}`;
  el.append(h2);

  // A few bars of "content" so consecutive slides differ across most of the frame.
  for (const w of [78, 62, 88, 45]) {
    const r = document.createElement('div');
    r.className = 'rule';
    r.style.width = `${w}%`;
    r.style.background = s.ink;
    r.style.opacity = '.16';
    el.append(r);
  }
  const block = document.createElement('div');
  block.className = 'block';
  block.style.width = '46%';
  block.style.background = s.accent;
  el.append(block);

  stage.insertBefore(el, hud);
  return el;
});

function show(i) {
  index = (i + SLIDES.length) % SLIDES.length;
  nodes.forEach((n, k) => n.classList.toggle('on', k === index));
  hud.textContent = `สไลด์ ${index + 1} / ${SLIDES.length}`;
}

$('next').addEventListener('click', () => show(index + 1));
$('prev').addEventListener('click', () => show(index - 1));

// Rapid-fire changes: the detector should end up saving the slide it settles on,
// not a half-drawn frame from the middle of the burst.
$('burst').addEventListener('click', async () => {
  for (let i = 0; i < 5; i++) {
    show(index + 1);
    await new Promise((r) => setTimeout(r, 700));
  }
});

$('cam').addEventListener('change', () => {
  $('camBox').classList.toggle('moving', $('cam').checked);
});

$('fade').addEventListener('input', () => {
  const ms = Number($('fade').value);
  $('fadeLabel').textContent = ms;
  document.documentElement.style.setProperty('--fade', `${ms}ms`);
});

$('auto').addEventListener('change', () => {
  clearInterval(autoTimer);
  const sec = Number($('auto').value) || 0;
  if (sec > 0) autoTimer = setInterval(() => show(index + 1), sec * 1000);
});

show(0);
