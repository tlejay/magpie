// IndexedDB — everything a recording session produces lands here.
//
// Why not chrome.storage.local: audio for a two-hour meeting is tens of MB and
// slides are binary. chrome.storage would force base64 (a 33% size penalty) and
// rewrite the whole value on every append. IndexedDB stores Blobs directly and
// appends cheaply, which is what a long recording needs.

const DB_NAME = 'magpie';
const DB_VERSION = 1;

export const STORE = {
  SESSIONS: 'sessions',
  CHUNKS: 'chunks',   // audio, one record per MediaRecorder timeslice
  SLIDES: 'slides',
  QR_HITS: 'qrHits',
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE.SESSIONS)) {
        db.createObjectStore(STORE.SESSIONS, { keyPath: 'id' });
      }
      for (const name of [STORE.CHUNKS, STORE.SLIDES, STORE.QR_HITS]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- sessions

export async function createSession(meta) {
  const db = await openDb();
  const session = {
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startedAt: Date.now(),
    endedAt: null,
    tabTitle: meta.tabTitle || '',
    tabUrl: meta.tabUrl || '',
    features: meta.features || {},
    audioMimeType: meta.audioMimeType || null,
    micIncluded: !!meta.micIncluded,
    counts: { chunks: 0, slides: 0, qrHits: 0 },
  };
  const t = tx(db, [STORE.SESSIONS], 'readwrite');
  t.objectStore(STORE.SESSIONS).put(session);
  await done(t);
  return session;
}

export async function updateSession(id, patch) {
  const db = await openDb();
  const t = tx(db, [STORE.SESSIONS], 'readwrite');
  const store = t.objectStore(STORE.SESSIONS);
  const current = await request(store.get(id));
  if (!current) {
    await done(t);
    return null;
  }
  const next = { ...current, ...patch };
  store.put(next);
  await done(t);
  return next;
}

export async function endSession(id) {
  return updateSession(id, { endedAt: Date.now() });
}

export async function listSessions() {
  const db = await openDb();
  const t = tx(db, [STORE.SESSIONS], 'readonly');
  const all = await request(t.objectStore(STORE.SESSIONS).getAll());
  await done(t);
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id) {
  const db = await openDb();
  const t = tx(db, [STORE.SESSIONS], 'readonly');
  const s = await request(t.objectStore(STORE.SESSIONS).get(id));
  await done(t);
  return s || null;
}

// ---------------------------------------------------------------- appends

async function append(storeName, record) {
  const db = await openDb();
  const t = tx(db, [storeName], 'readwrite');
  t.objectStore(storeName).add(record);
  await done(t);
}

export function putAudioChunk(sessionId, seq, blob, offsetMs) {
  return append(STORE.CHUNKS, { sessionId, seq, blob, offsetMs, ts: Date.now() });
}

export function putSlide(sessionId, seq, blob, offsetMs, meta = {}) {
  return append(STORE.SLIDES, { sessionId, seq, blob, offsetMs, ts: Date.now(), ...meta });
}

export function putQrHit(sessionId, hit) {
  return append(STORE.QR_HITS, { sessionId, ts: Date.now(), ...hit });
}

// ---------------------------------------------------------------- reads

async function bySession(storeName, sessionId) {
  const db = await openDb();
  const t = tx(db, [storeName], 'readonly');
  const index = t.objectStore(storeName).index('sessionId');
  const rows = await request(index.getAll(IDBKeyRange.only(sessionId)));
  await done(t);
  // Insertion order is not guaranteed by getAll on an index, and audio chunks
  // reassembled out of order produce a corrupt file.
  return rows.sort((a, b) => (a.seq ?? a.ts) - (b.seq ?? b.ts));
}

export const getAudioChunks = (sessionId) => bySession(STORE.CHUNKS, sessionId);
export const getSlides = (sessionId) => bySession(STORE.SLIDES, sessionId);
export const getQrHits = (sessionId) => bySession(STORE.QR_HITS, sessionId);

export async function getSessionBundle(sessionId) {
  const [session, chunks, slides, qrHits] = await Promise.all([
    getSession(sessionId),
    getAudioChunks(sessionId),
    getSlides(sessionId),
    getQrHits(sessionId),
  ]);
  return { session, chunks, slides, qrHits };
}

/** Live counts, so the UI can show progress without loading any blobs. */
export async function getCounts(sessionId) {
  const db = await openDb();
  const out = {};
  for (const [key, store] of [['chunks', STORE.CHUNKS], ['slides', STORE.SLIDES], ['qrHits', STORE.QR_HITS]]) {
    const t = tx(db, [store], 'readonly');
    out[key] = await request(t.objectStore(store).index('sessionId').count(IDBKeyRange.only(sessionId)));
    await done(t);
  }
  return out;
}

// ---------------------------------------------------------------- cleanup

export async function deleteSession(sessionId) {
  const db = await openDb();
  for (const store of [STORE.CHUNKS, STORE.SLIDES, STORE.QR_HITS]) {
    const t = tx(db, [store], 'readwrite');
    const index = t.objectStore(store).index('sessionId');
    const keys = await request(index.getAllKeys(IDBKeyRange.only(sessionId)));
    for (const key of keys) t.objectStore(store).delete(key);
    await done(t);
  }
  const t = tx(db, [STORE.SESSIONS], 'readwrite');
  t.objectStore(STORE.SESSIONS).delete(sessionId);
  await done(t);
}

/** Rough on-disk usage, for showing the user how much they're holding. */
export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
