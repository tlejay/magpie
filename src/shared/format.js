// Tiny formatting helpers that carry no dependencies.
//
// Split out of export.js so the popup can show an elapsed time without pulling
// in the ZIP builder — and with it IndexedDB — before its first paint.

export function formatOffset(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
