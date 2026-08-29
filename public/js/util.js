/* 工具函数：图标、Markdown 渲染、时间格式化、杂项 */

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 图标库（SVG） ---------- */
const I = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}${extra}</svg>`;
export const ICONS = {
  home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  tag: I('<path d="M20.6 13.4 12 22 2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.2"/>'),
  mic: I('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>'),
  link: I('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 8 5-5 5 5M12 3v12"/>'),
  download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
  note: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  video: I('<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-3v10l-6-3"/>'),
  doc: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>'),
  back: I('<path d="m15 18-6-6 6-6"/>'),
  ext: I('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>'),
  play: I('<path d="m6 4 14 8-14 8Z"/>'),
  stop: I('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  trash: I('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  copy: I('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  sparkle: I('<path d="M12 2l1.9 5.7a2 2 0 0 0 1.3 1.3L21 11l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 20l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 11l5.8-2a2 2 0 0 0 1.3-1.3Z"/>'),
};
export function icon(name) { return ICONS[name] || ''; }

/* 平台识别与配色（用于列表/来源卡图标） */
const PLATFORMS = {
  bilibili: { name: 'B站', color: '#fb7299', letter: 'B' },
  douyin: { name: '抖音', color: '#161823', letter: '抖' },
  xiaohongshu: { name: '小红书', color: '#ff2442', letter: '红' },
  youtube: { name: 'YouTube', color: '#ff0000', letter: '▶' },
  twitter: { name: 'X', color: '#000000', letter: '𝕏' },
  instagram: { name: 'Instagram', color: 'linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)', letter: 'IG' },
  tiktok: { name: 'TikTok', color: '#161823', letter: 'T' },
  weibo: { name: '微博', color: '#e6162d', letter: '微' },
  wechat: { name: '微信公众号', color: '#07c160', letter: '微' },
  zhihu: { name: '知乎', color: '#0084ff', letter: '知' },
  podcast: { name: '播客', color: '#8b5cf6', letter: '播' },
  generic: { name: '网页', color: '#8e8e88', letter: '网' },
};
export function platformOf(url = '') {
  const u = url.toLowerCase();
  const keys = [
    ['bilibili.com|b23.tv', 'bilibili'], ['douyin.com|iesdouyin', 'douyin'],
    ['xiaohongshu.com|xhslink', 'xiaohongshu'], ['youtube.com|youtu.be', 'youtube'],
    ['twitter.com|x.com', 'twitter'], ['instagram.com', 'instagram'], ['tiktok.com', 'tiktok'],
    ['weibo.com|weibo.cn', 'weibo'], ['mp.weixin.qq.com', 'wechat'], ['zhihu.com', 'zhihu'],
    ['podcasts.apple|xiaoyuzhoufm.com', 'podcast'],
  ];
  for (const [k, v] of keys) if (new RegExp(k).test(u)) return v;
  return 'generic';
}
export function platformMeta(key) { return PLATFORMS[key] || PLATFORMS.generic; }

/* ---------- 时间 ---------- */
export function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}min ${s ? s + 's' : ''}`.trim();
  return `${Math.floor(m / 60)}h ${m % 60}min`;
}
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 文本 ---------- */
export function stripMd(md = '') {
  return md.replace(/[#*`>\-|[\]()]/g, '').replace(/\s+/g, ' ').trim();
}
export function isChineseText(s = '') {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (s.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return cjk > kana + hangul && cjk * 2 > latin;
}

/* 语言检测：zh / ja / ko / en / id（印尼语）/ other
 * 中日韩按文字系统判断；拉丁字母语言按功能词（stopword）频率区分——
 * 印尼语的 yang/dan/tidak/itu/dengan 等功能词在英语中几乎不出现，区分度极高 */
const EN_WORDS = new Set(('the and is are of to in that it for with you this can will have be was were on at as or not '
  + 'but they we he she his her from what when who how do does did i me my your if so there their would could should').split(' '));
const ID_WORDS = new Set(('yang dan di itu dengan untuk tidak ini dari dalam akan pada saya kamu kita mereka adalah bisa '
  + 'sudah kalau tapi juga atau karena ada nggak gak ngga banget aja sama oleh lagi mau harus orang semua waktu banyak '
  + 'jadi kayak gimana gitu doang sih kok ya jangan terus bilang tahu tau emang memang cuma hanya biar supaya kalau').split(' '));
export function detectLang(s = '') {
  const sample = (s || '').slice(0, 6000);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  if (kana > 3 && kana * 3 > cjk) return 'ja';
  if (hangul > 10 && hangul > cjk) return 'ko';
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && cjk * 2 > latin) return 'zh';
  const tokens = sample.toLowerCase().match(/[a-z']+/g) || [];
  if (!tokens.length) return cjk ? 'zh' : 'other';
  let en = 0, id = 0;
  for (const t of tokens) { if (EN_WORDS.has(t)) en++; if (ID_WORDS.has(t)) id++; }
  const idRatio = id / tokens.length, enRatio = en / tokens.length;
  if (idRatio >= 0.05 && idRatio > enRatio * 1.25) return 'id';
  if (enRatio >= 0.1) return 'en';
  return 'other'; // 西语/葡语/法语等拉丁语言 → 视作待翻译外语
}
export const LANG_NAMES = { zh: '中文', en: '英语', id: '印尼语', ja: '日语', ko: '韩语', other: '外语' };
export function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
}
export function download(filename, content, type = 'text/markdown') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- 轻量 Markdown 渲染 ---------- */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
export function renderMd(md = '') {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null, table = null, inCode = false, codeBuf = [], para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.type}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.type}>`); list = null; } };
  const flushT = () => {
    if (table && table.length) {
      let html = '<table><thead><tr>' + table[0].map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (let r = 1; r < table.length; r++) {
        if (table[r].every(c => /^:?-+:?$/.test(c.trim()))) continue;
        html += '<tr>' + table[r].map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
      }
      out.push(html + '</tbody></table>');
    }
    table = null;
  };
  const flushAll = () => { flushP(); flushL(); flushT(); };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); codeBuf = []; inCode = false; }
      else { flushAll(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushP(); flushL(); table.push(line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); continue; }
    flushT();
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*+])\s+(.*)/.test(line)) {
      flushP(); if (table) flushT();
      if (!list || list.type !== 'ul') { flushL(); list = { type: 'ul', items: [] }; }
      list.items.push(/^\s*[-*+]\s+(.*)/.exec(line)[2]); continue;
    }
    if (/^\s*\d+[.、)]\s+(.*)/.test(line)) {
      flushP();
      if (!list || list.type !== 'ol') { flushL(); list = { type: 'ol', items: [] }; }
      list.items.push(/^\s*\d+[.、)]\s+(.*)/.exec(line)[1]); continue;
    }
    if (/^>\s?/.test(line)) { flushAll(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^(---+|\*\*\*+)$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }
    if (!line.trim()) { flushAll(); continue; }
    para.push(line.trim());
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}
