/* 数据存储：IndexedDB 笔记 + localStorage 设置 */

const DB_NAME = 'leanin-local';
const STORE = 'notes';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: 'id' });
        st.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const req = fn(st);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

/* 笔记变更通知（供自动备份等订阅） */
const notify = () => { try { window.dispatchEvent(new CustomEvent('leanin-notes-changed')); } catch {} };

export const db = {
  async all() {
    const items = await tx('readonly', st => st.getAll());
    return (items || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  get(id) { return tx('readonly', st => st.get(id)); },
  async put(note) { note.updatedAt = Date.now(); await tx('readwrite', st => st.put(note)); notify(); return note; },
  async patch(id, obj) {
    const n = await db.get(id);
    if (!n) throw new Error('笔记不存在');
    Object.assign(n, obj, { updatedAt: Date.now() });
    await tx('readwrite', st => st.put(n));
    notify();
    return n;
  },
  async del(id) { await tx('readwrite', st => st.delete(id)); notify(); },
};

/* ---------- 设置（localStorage） ---------- */
const KEY = 'leanin_settings';
/* 默认服务地址：本机打开 → 当前源；部署在 https 静态托管（如 GitHub Pages）→ 本地 HTTPS 端口 */
const isLocalOrigin = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'http:';
const DEFAULTS = {
  serverUrl: isLocalOrigin ? location.origin : 'https://127.0.0.1:5219',
  llmBase: 'https://open.bigmodel.cn/api/paas/v4',
  llmKey: '',
  llmModel: 'glm-4-flash',
  llmViaServer: true,          // 通过本地服务转发，避免浏览器 CORS
  accessToken: '',             // 访问令牌：服务端设置了令牌后，调用 AI 必须携带
  useServerKey: false,         // Key 已保存到本地服务端（浏览器不再保留明文）
  whisperModel: 'base',        // tiny | base | small
  audioLang: 'auto',           // auto | zh | en | ja ...
  diarize: true,               // 声纹识别说话人（pyannote，约6MB）
  alwaysWhisper: true,         // 即使拿到平台字幕也下载音频跑 Whisper，两份并列供 LLM 综合
  autoBackup: true,            // 笔记变更后自动备份到本地服务（滚动保留 10 份）
  lastBackupAt: 0,
  hfMirror: false,             // 使用 hf-mirror.com
  translateMode: 'en-skip',    // en-skip: 英语不翻译其他外语翻译 | all: 全部翻译 | off: 不翻译
  noTranslate: false,          // (旧设置，仅用于迁移)
  bannerDismissed: false,
};
export function getSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  if (!s.translateMode) s.translateMode = s.noTranslate ? 'off' : DEFAULTS.translateMode; // 旧设置迁移
  return s;
}
export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export async function exportAll() {
  const notes = await db.all();
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes }, null, 2);
}
export async function importAll(jsonText) {
  const data = JSON.parse(jsonText);
  if (!Array.isArray(data.notes)) throw new Error('文件格式不正确');
  for (const n of data.notes) {
    if (!n || !n.id) continue;
    await db.put(n);
  }
  notify();
  return data.notes.length;
}
