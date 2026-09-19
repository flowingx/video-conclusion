/*
 * Leanin 本地复刻版 - 零依赖 Node.js 后端
 * 职责：静态页面服务、yt-dlp 链接解析与音频下载、文章正文抓取、LLM API 转发
 * 启动：node server.js   （默认 http://127.0.0.1:5218）
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const CONFIG_FILE = path.join(DATA, 'config.json');
const PORT = Number(process.env.PORT || 5218);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5219);
const HOST = process.env.HOST || '127.0.0.1';

const YT_DLP = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG = fs.existsSync(path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  ? path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  : 'ffmpeg';   // 云端容器：用系统 ffmpeg

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const AUDIO_MIME = {
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.m4s': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
};

for (const d of [DATA, MEDIA]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 配置 ---------------- */
let config = { cookiesBrowser: '', proxy: '', lang: 'auto', llmKey: '', accessToken: '' };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
// 云端部署（Render 等）：密钥用环境变量注入，容器重启不丢、不落盘
if (process.env.LLM_KEY) config.llmKey = process.env.LLM_KEY;
if (process.env.ACCESS_TOKEN) config.accessToken = process.env.ACCESS_TOKEN;
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
/* 对外只暴露非敏感字段与布尔状态，绝不回传 Key/令牌 */
function publicConfig() {
  return { cookiesBrowser: config.cookiesBrowser, proxy: config.proxy, hasKey: !!config.llmKey, hasToken: !!config.accessToken };
}
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------------- CSRF / CORS 防护 ----------------
 * 浏览器发出的跨站请求必带 Origin 头；白名单之外一律 403，
 * 防止恶意网页驱使你的本地服务（改代理窃取 Cookie / 白嫖解析等）。
 * curl 等非浏览器客户端不带 Origin，不受影响（仍受令牌门禁约束）。 */
const ORIGIN_OK = o =>
  !o || o === 'https://flowingx.github.io' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
  || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(o)
  || (!!process.env.ALLOWED_ORIGIN && o === process.env.ALLOWED_ORIGIN);

/* ---------------- 工具 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(res.__cors || {}) });
  res.end(body);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function runYtDlp(args, { timeoutMs = 20 * 60 * 1000, onLine } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(YT_DLP)) return resolve({ code: -1, stdout: '', stderr: 'yt-dlp 不存在，请先运行 setup 下载 bin/yt-dlp.exe' });
    const proc = spawn(YT_DLP, args, { windowsHide: true });
    let stdout = [], stdoutLen = 0, stderr = [];
    const CAP = 100 * 1024 * 1024;
    let buf = '';
    proc.stdout.on('data', c => {
      stdoutLen += c.length; if (stdoutLen <= CAP) stdout.push(c);
      if (onLine) { buf += c.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } }
    });
    proc.stderr.on('data', c => { if (stderr.length < 400) stderr.push(c.toString()); });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: stderr.join('') }); });
    proc.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(err) }); });
  });
}

/* Cookie 读取失败自动降级：
 * 两种常见 Windows 故障都会被全局 --cookies-from-browser 连坐：
 *   1) Chrome/Edge 运行时独占锁定 Cookies SQLite，无法复制（issue #7271）
 *   2) Chrome v127+ 的加密密钥无法用 DPAPI 解密（issue #10927）
 * 即使目标平台（TikTok/公开 YouTube/B 站）根本不需要登录 Cookie 也会失败。
 * 这里命中特征错误时去掉 --cookies-from-browser 重跑一次；仍失败再返回，让上层给出中文操作提示。 */
const COOKIE_LOCK_RE = /Could not copy [^\n]*cookie database|Failed to (?:read|copy|decrypt) cookies? from browser|Failed to decrypt with DPAPI|Failed to decrypt [^\n]*cookie|Permission denied[^\n]*Cookies|cannot access cookies|Unable to (?:read|copy) [^\n]*cookie/i;
function stripCookiesArg(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cookies-from-browser' || args[i] === '--cookies') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}
async function runYtDlpAuto(args, opts) {
  const first = await runYtDlp(args, opts);
  if (first.code === 0) return first;
  if (!COOKIE_LOCK_RE.test(first.stderr)) return first;
  if (stripCookiesArg(args).length === args.length) return { ...first, cookieLock: true };
  const second = await runYtDlp(stripCookiesArg(args), opts);
  if (second.code === 0) return { ...second, cookieFallback: true };
  return { ...second, cookieLock: true };
}
function friendlyCookieError(stderr, fallback) {
  if (COOKIE_LOCK_RE.test(stderr || '')) {
    return '浏览器 Cookie 读取失败（Chrome/Edge 运行时数据库被锁定，或新版 Chrome 的加密密钥无法用 DPAPI 解密）。请彻底关闭浏览器后重试；若仍失败，到设置里把"读取浏览器 Cookie"改为「不使用」（公开内容无需登录）或「Firefox」';
  }
  return fallback;
}

/* ---------------- 启动清理：删除超过 48 小时的音频缓存 ---------------- */
(function cleanup() {
  try {
    const cut = Date.now() - 48 * 3600 * 1000;
    for (const f of fs.readdirSync(MEDIA)) {
      const p = path.join(MEDIA, f);
      if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p);
    }
  } catch {}
})();

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { // SPA 兜底
      fs.readFile(path.join(PUB, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(b2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------------- 媒体文件（支持 Range） ---------------- */
function serveMedia(req, res, name) {
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(MEDIA, name);
  if (!fs.existsSync(file)) { sendJSON(res, 404, { error: '文件不存在（可能已被清理）' }); return; }
  const stat = fs.statSync(file);
  const type = AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1]) : 0;
    let end = m[2] ? parseInt(m[2]) : stat.size - 1;
    if (isNaN(start) || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1, ...(res.__cors || {}),
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', ...(res.__cors || {}) });
    fs.createReadStream(file).pipe(res);
  }
}

/* ---------------- 链接解析（yt-dlp -J） ---------------- */
function ytDlpBaseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--socket-timeout', '25', '--retries', '3'];
  if (config.cookiesBrowser) args.push('--cookies-from-browser', config.cookiesBrowser);
  if (config.proxy) args.push('--proxy', config.proxy);
  return args;
}

async function apiResolve(req, res, body) {
  const link = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(link)) return sendJSON(res, 400, { error: '链接格式不正确' });
  const { code, stdout, stderr, cookieLock } = await runYtDlpAuto([...ytDlpBaseArgs(), '-J', link], { timeoutMs: 3 * 60 * 1000 });
  if (code !== 0) {
    const raw = (stderr.split('\n').filter(l => l.includes('ERROR') || l.includes('ERROR:')).pop() || stderr.slice(-400)).trim();
    const msg = cookieLock ? friendlyCookieError(stderr, raw) : raw;
    return sendJSON(res, 422, { error: '解析失败：' + (msg || '未知错误').slice(0, 500) });
  }
  let info;
  try { info = JSON.parse(stdout); } catch { return sendJSON(res, 422, { error: '解析结果无法解析' }); }
  if (info._type === 'playlist' && Array.isArray(info.entries)) info = info.entries.find(e => e) || {};
  const formats = (info.formats || []).filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  formats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const bestAudio = formats[0] || null;
  sendJSON(res, 200, {
    platform: info.extractor_key || info.extractor || '未知平台',
    webpage_url: info.webpage_url || link,
    title: info.title || '未命名内容',
    uploader: info.uploader || info.channel || info.uploader_id || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    description: (info.description || '').slice(0, 2000),
    audio_ext: bestAudio ? bestAudio.ext : '',
  });
}

/* ---------------- 平台字幕提取（字幕优先，转写兜底） ---------------- */
function parseSubtitles(raw) {
  const ts = '(\\d{1,2}):(\\d{2}):(\\d{2})[.,](\\d{1,3})';
  const re = new RegExp(ts + '\\s*-->\\s*' + ts + '([\\s\\S]*?)(?=\\n[^\\n]*-->|\\n\\s*\\n|$)', 'g');
  const segs = [];
  let m;
  while ((m = re.exec(raw))) {
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4].padEnd(3, '0')) / 1000;
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + (+m[8].padEnd(3, '0')) / 1000;
    let t = m[9].split('\n').map(l => l.trim())
      .filter(l => l && !/^(WEBVTT|Kind:|Language:|NOTE)/i.test(l)).join(' ')
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const prev = segs[segs.length - 1];
    // 处理 YouTube 自动字幕的滚动重复：新行以上一行开头时替换
    if (prev && (t === prev.t || (t.startsWith(prev.t) && t.length > prev.t.length))) { prev.t = t; prev.e = +e.toFixed(2); continue; }
    segs.push({ s: +s.toFixed(2), e: +e.toFixed(2), t });
  }
  return segs;
}

async function apiSubs(req, res, body) {
  const link = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(link)) return sendJSON(res, 400, { error: '链接格式不正确' });
  const id = crypto.randomUUID();
  const tpl = path.join(MEDIA, id + '.%(ext)s');
  const args = [...ytDlpBaseArgs(), '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', '.*.*', '-o', tpl, link];
  const { code, stderr, cookieLock } = await runYtDlpAuto(args, { timeoutMs: 150000 });
  const files = fs.readdirSync(MEDIA).filter(f => f.startsWith(id) && /\.(vtt|srt|ttml)$/i.test(f));
  const cleanup = () => { for (const f of files) { try { fs.unlinkSync(path.join(MEDIA, f)); } catch {} } };
  if (!files.length) {
    const raw = (stderr.split('\n').filter(l => l.includes('ERROR')).pop() || '').trim();
    const msg = cookieLock ? friendlyCookieError(stderr, raw) : raw;
    return sendJSON(res, 404, { error: '该内容没有可用字幕' + (code !== 0 ? '（' + msg.slice(0, 200) + '）' : '') });
  }
  const score = f => {
    let s = 0;
    if (/zh.*(hans|cn|simply)|cmn/i.test(f)) s += 4; else if (/zh/i.test(f)) s += 3;
    else if (/en/i.test(f)) s += 2;
    if (/\.(vtt|srt)$/i.test(f)) s += 0.5;
    return s;
  };
  files.sort((a, b) => score(b) - score(a));
  const best = files[0];
  const raw = fs.readFileSync(path.join(MEDIA, best), 'utf8');
  const segments = parseSubtitles(raw);
  cleanup();
  if (!segments.length) return sendJSON(res, 404, { error: '字幕存在但解析为空' });
  const lang = /zh/i.test(best) ? 'zh' : /en/i.test(best) ? 'en' : 'other';
  sendJSON(res, 200, { lang, subtitle_file: best.replace(id + '.', ''), count: segments.length, segments });
}

/* ---------------- 音频下载任务 ---------------- */
const jobs = new Map();

async function apiDownload(req, res, body) {
  const link = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(link)) return sendJSON(res, 400, { error: '链接格式不正确' });
  const id = crypto.randomUUID();
  const hasFfmpeg = fs.existsSync(FFMPEG);
  const outTpl = path.join(MEDIA, id + '.%(ext)s');
  const args = [...ytDlpBaseArgs(), '--newline', '-f', 'bestaudio*', '--audio-quality', '0'];
  if (hasFfmpeg) args.push('-x', '--audio-format', 'm4a');
  args.push('-o', outTpl, link);
  jobs.set(id, { status: 'running', progress: 0, file: null, error: '' });
  runYtDlpAuto(args, {
    onLine: line => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) { const j = jobs.get(id); if (j) { j.progress = parseFloat(m[1]); } }
    },
  }).then(({ code, stderr, cookieLock }) => {
    const j = jobs.get(id); if (!j) return;
    if (code === 0) {
      let found = null;
      for (const f of fs.readdirSync(MEDIA)) if (f.startsWith(id)) { if (!found || fs.statSync(path.join(MEDIA, f)).size > fs.statSync(path.join(MEDIA, found)).size) found = f; }
      if (found) { j.status = 'done'; j.progress = 100; j.file = found; return; }
    }
    const raw = (stderr.split('\n').filter(l => l.includes('ERROR')).pop() || stderr.slice(-300)).trim();
    const msg = cookieLock ? friendlyCookieError(stderr, raw) : raw;
    j.status = 'error'; j.error = (msg || '下载失败').slice(0, 400);
  });
  sendJSON(res, 200, { id, ffmpeg: hasFfmpeg });
}

/* ---------------- 文章抓取 ---------------- */
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<h([1-3])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(+n + 1) + ' ')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<(strong|b)[^>]*>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.split('\n').map(l => l.replace(/[ \t\u3000]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i + 1])).join('\n');
  return s.trim();
}

async function apiArticle(req, res, body) {
  const link = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(link)) return sendJSON(res, 400, { error: '链接格式不正确' });
  let html = '';
  try {
    const r = await fetch(link, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow', signal: AbortSignal.timeout(30000),
    });
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct) && !ct.startsWith('application/json')) {
      return sendJSON(res, 422, { error: '该链接不是网页内容（' + ct.split(';')[0] + '）' });
    }
    html = await r.text();
  } catch (e) {
    return sendJSON(res, 422, { error: '抓取失败：' + String(e).slice(0, 200) });
  }
  if (html.length > 8 * 1024 * 1024) html = html.slice(0, 8 * 1024 * 1024);

  const meta = (prop) => {
    const q = '["\']';
    const re = new RegExp('<meta[^>]+(?:property|name)=' + q + prop + q + '[^>]+content=' + q + '([\\s\\S]*?)' + q, 'i');
    const re2 = new RegExp('<meta[^>]+content=' + q + '([\\s\\S]*?)' + q + '[^>]+(?:property|name)=' + q + prop + q, 'i');
    const m = re.exec(html) || re2.exec(html);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  let title = meta('og:title') || meta('twitter:title');
  if (!title) { const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); if (t) title = decodeEntities(t[1]).trim(); }
  const cover = meta('og:image') || '';
  let desc = meta('og:description') || meta('description') || '';

  let text = '';
  // 微信公众号
  const wx = /id="js_content"([\s\S]*?)(?:id="js_tags"|id="js_profile_qrcode"|class="rich_media_tool|<script)/i.exec(html);
  if (wx) text = htmlToText(wx[1]);
  // 知乎
  if (!text) { const zh = /class="(?:Post-RichText|RichContent-inner|AnswerItem)[^"]*"([\s\S]*?)<div class="(ContentItem-actions|Post-SideActions|Comments-container)/i.exec(html); if (zh) text = htmlToText(zh[1]); }
  // <article>
  if (!text) { const a = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html); if (a) text = htmlToText(a[1]); }
  // 兜底：body 全文
  if (!text || text.length < 200) {
    const b = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    text = htmlToText(b ? b[1] : html);
  }
  if (!title) title = '未命名文章';
  if (text.length < 80) return sendJSON(res, 422, { error: '未能提取到正文（页面可能需要登录，或为纯视频页面）。小红书/Instagram 等平台可在设置中开启浏览器 Cookie 后重试。' });
  sendJSON(res, 200, { title: title.slice(0, 200), cover, desc, text: text.slice(0, 200000), site: new URL(link).hostname });
}

/* ---------------- LLM 转发（流式透传） ---------------- */
async function apiLlm(req, res, body) {
  /* 令牌门禁：服务端设置了令牌后，所有 AI 调用都必须携带，防止他人盗用 */
  if (config.accessToken && !safeEq(req.headers['x-access-token'], config.accessToken)) {
    return sendJSON(res, 401, { error: '需要访问令牌：请在设置中填写访问令牌' });
  }
  const { baseUrl = 'https://open.bigmodel.cn/api/paas/v4', model, messages, stream, temperature, max_tokens } = body || {};
  const apiKey = body.apiKey || config.llmKey;   // 浏览器未带 Key 时使用服务端保存的 Key
  if (!apiKey) return sendJSON(res, 400, { error: '缺少 API Key（浏览器或服务端均未配置）' });
  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, stream: !!stream, ...(temperature != null ? { temperature } : {}), ...(max_tokens ? { max_tokens } : {}) }),
      signal: AbortSignal.timeout(stream ? 600000 : 300000),
    });
  } catch (e) {
    return sendJSON(res, 502, { error: '无法连接 LLM 服务：' + String(e).slice(0, 200) });
  }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    return sendJSON(res, upstream.status, { error: `LLM 返回 ${upstream.status}：` + t.slice(0, 500) });
  }
  if (!stream) {
    const data = await upstream.json();
    return sendJSON(res, 200, data);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', ...(res.__cors || {}),
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {} finally { res.end(); }
}

/* ---------------- 备份（笔记数据滚动保存最近 10 份） ---------------- */
function apiBackup(req, res, body) {
  const data = String(body.data || '');
  try { const j = JSON.parse(data); if (!Array.isArray(j.notes)) throw new Error('no notes'); } catch {
    return sendJSON(res, 400, { error: '备份内容格式不正确' });
  }
  const dir = path.join(DATA, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  fs.writeFileSync(path.join(dir, name), data);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files.slice(10)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  sendJSON(res, 200, { ok: true, file: name, kept: Math.min(10, files.length) });
}

/* ---------------- 路由 ---------------- */
async function handler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const origin = req.headers.origin;
  if (!ORIGIN_OK(origin)) { res.writeHead(403); return res.end('forbidden origin'); }
  res.__cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...res.__cors, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-access-token' }); return res.end(); }
  // 令牌门禁：设置令牌后，除健康检查与音频文件外，全部 /api/* 均需携带令牌
  if (config.accessToken && p.startsWith('/api/')) {
    const exempt = req.method === 'GET' && (p === '/api/health' || p.startsWith('/api/media/'));
    if (!exempt && !safeEq(req.headers['x-access-token'], config.accessToken)) {
      return sendJSON(res, 401, { error: '需要访问令牌' });
    }
  }
  try {
    if (req.method === 'GET' && p === '/api/health') {
      let v = '';
      if (fs.existsSync(YT_DLP)) v = (await runYtDlp(['--version'], { timeoutMs: 15000 })).stdout.trim();
      return sendJSON(res, 200, { ok: true, ytDlp: v, ffmpeg: fs.existsSync(FFMPEG), config: publicConfig() });
    }
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, publicConfig());
    if (req.method === 'POST' && p === '/api/config') {
      const b = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      // Key/令牌/代理/Cookie 都是敏感配置：服务端已设令牌时，改动必须携带旧令牌
      const touchesSecrets = 'llmKey' in b || 'accessToken' in b || 'cookiesBrowser' in b || 'proxy' in b;
      if (touchesSecrets && config.accessToken && !safeEq(req.headers['x-access-token'], config.accessToken)) {
        return sendJSON(res, 403, { error: '服务端已设置访问令牌，请先在请求头中携带当前令牌' });
      }
      if (typeof b.llmKey === 'string') config.llmKey = b.llmKey.trim().slice(0, 400);
      if (typeof b.accessToken === 'string') config.accessToken = b.accessToken.trim().slice(0, 200);
      for (const k of ['cookiesBrowser', 'proxy']) if (typeof b[k] === 'string') config[k] = b[k].slice(0, 300);
      saveConfig();
      return sendJSON(res, 200, publicConfig());
    }
    if (req.method === 'POST' && p === '/api/resolve') return apiResolve(req, res, JSON.parse((await readBody(req)).toString() || '{}'));
    if (req.method === 'POST' && p === '/api/subs') return apiSubs(req, res, JSON.parse((await readBody(req)).toString() || '{}'));
    if (req.method === 'POST' && p === '/api/download') return apiDownload(req, res, JSON.parse((await readBody(req)).toString() || '{}'));
    if (req.method === 'GET' && p.startsWith('/api/job/')) { const j = jobs.get(p.slice('/api/job/'.length)); return j ? sendJSON(res, 200, j) : sendJSON(res, 404, { error: '任务不存在' }); }
    if (req.method === 'POST' && p === '/api/article') return apiArticle(req, res, JSON.parse((await readBody(req)).toString() || '{}'));
    if (req.method === 'POST' && p === '/api/llm') return apiLlm(req, res, JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString() || '{}'));
    if (req.method === 'POST' && p === '/api/backup') return apiBackup(req, res, JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString() || '{}'));
    if (req.method === 'GET' && p === '/api/backup') {
      const dir = path.join(DATA, 'backups');
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 10)
          .map(f => { const st = fs.statSync(path.join(dir, f)); return { file: f, size: st.size, time: st.mtimeMs }; })
        : [];
      return sendJSON(res, 200, { files });
    }
    if (req.method === 'GET' && p.startsWith('/api/media/')) return serveMedia(req, res, p.slice('/api/media/'.length));
    if (req.method === 'GET') return serveStatic(req, res, decodeURIComponent(p));
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { error: '服务器内部错误：' + String(e).slice(0, 300) });
  }
}

/* ---------------- 自签名证书（供 GitHub Pages 等 HTTPS 前端调用） ---------------- */
function ensureCert() {
  const certFile = path.join(DATA, 'cert.pem'), keyFile = path.join(DATA, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try { return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }; } catch {}
  }
  const cands = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ];
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile, '-days', '3650', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost'];
  for (const c of cands) {
    try {
      const r = spawnSync(c, args, { stdio: 'ignore', timeout: 30000 });
      if (r.status === 0 && fs.existsSync(certFile)) return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    } catch {}
  }
  return null;
}

const httpServer = http.createServer(handler);
httpServer.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ✅ Leanin 本地版已启动');
  console.log(`  👉 本机使用        http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  const cert = ensureCert();
  if (cert) {
    try {
      https.createServer(cert, handler).listen(HTTPS_PORT, HOST, () => {
        console.log(`  🔒 HTTPS 端口(供 GitHub Pages 前端用)  https://127.0.0.1:${HTTPS_PORT}`);
        console.log('     首次使用：浏览器打开上面的 HTTPS 地址 → 高级 → 继续前往（信任自签名证书，仅需一次）');
      });
    } catch (e) { console.log('  HTTPS 端口启动失败：' + String(e).slice(0, 120)); }
  } else {
    console.log('  ⚠ 未找到 openssl，无法启用 HTTPS 端口（GitHub Pages 前端模式不可用，本机使用不受影响）');
  }
  console.log(`  yt-dlp: ${fs.existsSync(YT_DLP) ? 'OK' : '缺失(bin/yt-dlp.exe)'}   ffmpeg: ${fs.existsSync(FFMPEG) ? 'OK' : '缺失(bin/ffmpeg.exe)'}`);
  console.log('');
});
