/* 主应用：路由 / 工作台 / 解析流水线 / 详情页 / 录音 / 设置 / AI对话 */
import { $, $$, esc, icon, platformOf, platformMeta, fmtDur, fmtClock, fmtDate, stripMd, detectLang, LANG_NAMES, toast, download, renderMd } from './util.js';
import { db, uid, getSettings, saveSettings, exportAll, importAll } from './db.js';
import { summarize, summarizeLong, translateText, translateSegments, polishNote, chatWith, llmReady } from './llm.js';
import { decodeAudio, transcribe, diarize, MODELS } from './transcribe.js';

const S = getSettings();
const main = $('#main');
let notes = [];
let currentId = null;
let batchMode = false;
const batchSel = new Set();
const runningPipelines = new Set();   // 防止重复执行
const chatHistories = new Map();      // noteId -> messages

/* ================= 基础 ================= */
async function api(path, body) {
  const r = await fetch(S.serverUrl.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(S.accessToken ? { 'x-access-token': S.accessToken } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null;
  try { j = await r.json(); } catch { j = { error: 'HTTP ' + r.status }; }
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
const mediaUrl = f => S.serverUrl.replace(/\/$/, '') + '/api/media/' + encodeURIComponent(f);

function saveS(patch) { Object.assign(S, saveSettings(patch)); }

async function refreshNotes() { notes = await db.all(); }

/* 步骤面板状态（内存） */
const stepState = { noteId: null, steps: [] };
function setSteps(noteId, steps) { stepState.noteId = noteId; stepState.steps = steps; renderSteps(); }
function stepSet(name, status, msg, progress) {
  if (stepState.noteId !== currentId) return;
  const st = stepState.steps.find(s => s.name === name);
  if (!st) return;
  Object.assign(st, { status, msg: msg ?? st.msg, progress: progress ?? st.progress });
  renderSteps();
}
function renderSteps() {
  const el = $('#workpanel'); if (!el) return;
  el.hidden = !stepState.steps.length;
  el.innerHTML = `<div class="wp-title">${icon('sparkle')} 处理进度</div><div class="wp-steps">` +
    stepState.steps.map(s => `
      <div class="wp-step ${s.status}">
        <span class="wp-step-ic">${s.status === 'done' ? '✓' : s.status === 'err' ? '!' : ''}</span>
        <span style="min-width:96px">${esc(s.label)}</span>
        ${s.status === 'active' && s.progress != null ? `<div class="progress-bar"><div style="width:${Math.round(s.progress * 100)}%"></div></div>` : ''}
        <span style="font-size:12px;color:var(--text3)">${esc(s.msg || '')}</span>
      </div>`).join('') +
    `</div>`;
}

/* ================= 路由 ================= */
async function route() {
  const h = location.hash || '#/workbench';
  const m = h.match(/^#\/resource\/(.+)$/);
  await refreshNotes();
  if (m) { currentId = m[1]; renderDetail(); return; }
  currentId = null;
  if (h.startsWith('#/tags')) { renderTags(h.split('/')[2] && decodeURIComponent(h.split('/')[2])); }
  else if (h.startsWith('#/record')) { renderRecord(); }
  else if (h.startsWith('#/settings')) { renderSettings(); }
  else { renderWorkbench(); }
  $$('.nav-item[data-nav]').forEach(a => a.classList.toggle('active', h.startsWith('#/' + a.dataset.nav)));
}
window.addEventListener('hashchange', route);

/* ================= 工作台 ================= */
function renderWorkbench() {
  const kindIcon = { video: 'video', file: 'video', article: 'doc', note: 'note', record: 'mic' };
  main.innerHTML = `<div class="col">
    <div class="quick-cards">
      <button class="qcard" id="qc-note"><div class="qcard-ic ic-orange">${icon('note')}</div><div class="qcard-t">新建笔记</div><div class="qcard-d">记录灵感，AI 创作</div></button>
      <button class="qcard" id="qc-link"><div class="qcard-ic ic-purple">${icon('link')}</div><div class="qcard-t">解析链接</div><div class="qcard-d">提取文稿，智能总结</div></button>
      <button class="qcard" id="qc-upload"><div class="qcard-ic ic-green">${icon('upload')}</div><div class="qcard-t">上传音视频</div><div class="qcard-d">智能解析，AI 总结</div></button>
      <button class="qcard" id="qc-rec"><div class="qcard-ic ic-blue">${icon('mic')}</div><div class="qcard-t">实时录音</div><div class="qcard-d">现场记录，实时转写</div></button>
    </div>
    <div class="sec-title" style="display:flex;align-items:center;gap:10px">
      <span style="flex:1">我的资料</span>
      ${notes.length ? `<button class="btn btn-ghost btn-sm" id="btn-batch">${batchMode ? '退出批量' : '批量管理'}</button>` : ''}
    </div>
    ${batchMode ? `<div class="batch-bar">
      <label class="batch-all"><input type="checkbox" id="batch-all" ${batchSel.size && batchSel.size === notes.length ? 'checked' : ''}> 全选</label>
      <span class="batch-count">已选 ${batchSel.size} 项</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" id="batch-export" ${batchSel.size ? '' : 'disabled'}>导出所选</button>
      <button class="btn btn-primary btn-sm" id="batch-del" ${batchSel.size ? '' : 'disabled'}>删除所选</button>
    </div>` : ''}
    <div class="mlist" id="mlist"></div>
  </div>`;
  $('#qc-link').onclick = linkModal;
  $('#qc-upload').onclick = uploadModal;
  $('#qc-note').onclick = noteModal;
  $('#qc-rec').onclick = () => location.hash = '#/record';

  const list = $('#mlist');
  if (!notes.length) { list.innerHTML = `<div class="empty"><div class="empty-ic">📂</div>还没有资料，试试上方的「解析链接」</div>`; return; }
  list.innerHTML = notes.map(n => {
    const pm = platformMeta(n.platform || (n.kind === 'article' ? 'wechat' : 'generic'));
    const excerpt = n.summaryMd ? stripMd(n.summaryMd).slice(0, 110) : (n.contentMd ? stripMd(n.contentMd).slice(0, 110) : (n.kind === 'note' ? '（空笔记）' : ''));
    const ic = `<div class="mcard-ic" style="background:${pm.color}">${n.kind === 'article' || n.kind === 'note' ? icon('doc') : n.kind === 'record' ? icon('mic') : icon('video')}</div>`;
    const check = batchMode ? `<span class="mcard-check"><input type="checkbox" data-check="${n.id}" ${batchSel.has(n.id) ? 'checked' : ''}></span>` : '';
    return `<button class="mcard${batchMode ? ' batch' : ''}${batchSel.has(n.id) ? ' picked' : ''}" data-id="${n.id}">
      ${check}${ic}
      <div class="mcard-body">
        <div class="mcard-top"><span class="mcard-title">${esc(n.title || '未命名')}</span><span class="mcard-date">${fmtDate(n.createdAt)}</span></div>
        <div class="mcard-excerpt">${esc(excerpt)}</div>
        <div class="mcard-meta">${n.duration ? `<span>${fmtDur(n.duration)}</span>` : ''}${(n.tags || []).slice(0, 3).map(t => `<span class="tagchip">#${esc(t)}</span>`).join('')}</div>
      </div>
    </button>`;
  }).join('');
  const bb = $('#btn-batch');
  if (bb) bb.onclick = () => { batchMode = !batchMode; batchSel.clear(); renderWorkbench(); };
  const ba = $('#batch-all');
  if (ba) ba.onchange = () => { batchSel.clear(); if (ba.checked) notes.forEach(n => batchSel.add(n.id)); renderWorkbench(); };
  const bd = $('#batch-del');
  if (bd) bd.onclick = async () => {
    if (!batchSel.size) return;
    if (!confirm(`确定删除所选的 ${batchSel.size} 条资料？此操作不可恢复。`)) return;
    for (const id of batchSel) await db.del(id);
    toast(`已删除 ${batchSel.size} 条`);
    batchSel.clear(); batchMode = false;
    await refreshNotes(); renderWorkbench();
  };
  const be = $('#batch-export');
  if (be) be.onclick = async () => {
    for (const id of batchSel) {
      const n = await db.get(id);
      if (n) exportNoteMd(n);
      await new Promise(r => setTimeout(r, 350));
    }
    toast(`已导出 ${batchSel.size} 个 Markdown 文件`);
  };
  $$('.mcard', list).forEach(b => b.onclick = () => {
    const id = b.dataset.id;
    if (batchMode) {
      batchSel.has(id) ? batchSel.delete(id) : batchSel.add(id);
      renderWorkbench();
    } else location.hash = '#/resource/' + id;
  });
}

/* ================= 标签页 ================= */
function renderTags(active) {
  const counter = {};
  for (const n of notes) for (const t of (n.tags || [])) counter[t] = (counter[t] || 0) + 1;
  const tags = Object.entries(counter).sort((a, b) => b[1] - a[1]);
  main.innerHTML = `<div class="col">
    <div class="sec-title">标签</div>
    ${tags.length ? `<div class="tag-cloud">${tags.map(([t, c]) => `<button class="tag-big" data-t="${esc(t)}">#${esc(t)}<span>${c}</span></button>`).join('')}</div>` : `<div class="empty"><div class="empty-ic">🏷️</div>还没有标签，AI 总结后会自动打标签</div>`}
    <div id="tag-list" style="margin-top:26px"></div>
  </div>`;
  if (active) filterByTag(active);
  $$('.tag-big').forEach(b => b.onclick = () => filterByTag(b.dataset.t));
  function filterByTag(t) {
    $$('.tag-big').forEach(b => b.style.borderColor = b.dataset.t === t ? 'var(--accent)' : '');
    const items = notes.filter(n => (n.tags || []).includes(t));
    $('#tag-list').innerHTML = items.length
      ? `<div class="sec-title" style="margin-top:0">#${esc(t)} · ${items.length} 条</div><div class="mlist">` + items.map(n =>
        `<button class="mcard" data-id="${n.id}"><div class="mcard-body"><div class="mcard-top"><span class="mcard-title">${esc(n.title)}</span><span class="mcard-date">${fmtDate(n.createdAt)}</span></div></div></button>`).join('') + '</div>'
      : '';
    $$('#tag-list .mcard').forEach(b => b.onclick = () => location.hash = '#/resource/' + b.dataset.id);
  }
}

/* ================= 弹窗 ================= */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal"><button class="modal-x">✕</button>${html}</div></div>`;
  $('.modal-mask', root).onclick = e => { if (e.target === e.currentTarget) closeModal(); };
  $('.modal-x', root).onclick = closeModal;
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function linkModal() {
  const root = openModal(`
    <div class="modal-title">解析链接</div>
    <textarea id="link-input" rows="4" placeholder="将视频/图文链接粘贴到这里，即可提取文稿并 AI 总结"></textarea>
    <div class="hint">支持视频链接与图文页面；需要登录可见的内容（小红书/Instagram 等）可在「设置」开启浏览器 Cookie</div>
    <div class="plat-chips">
      ${['B站', '抖音', '小红书', 'YouTube', 'X/Twitter', 'Instagram', 'TikTok', '微博', '微信公众号', '知乎', '播客'].map(p => `<span class="plat-chip">${p}</span>`).join('')}
    </div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" id="link-ok" disabled>确定</button></div>
  `);
  const inp = $('#link-input', root), ok = $('#link-ok', root);
  inp.focus();
  inp.oninput = () => ok.disabled = !inp.value.trim();
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && inp.value.trim()) { e.preventDefault(); ok.click(); } };
  ok.onclick = async () => {
    const url = extractUrl(inp.value);
    if (!url) return toast('请粘贴有效链接', true);
    closeModal();
    const n = await db.put({ id: uid(), kind: 'video', title: '解析中…', sourceUrl: url, createdAt: Date.now(), status: 'working' });
    location.hash = '#/resource/' + n.id;
    await refreshNotes();
    runLinkPipeline(n.id);
  };
}
function extractUrl(s) {
  const m = /https?:\/\/[^\s"'<>,；;，）)]+/i.exec(s || '');
  return m ? m[0] : '';
}

function uploadModal() {
  const root = openModal(`
    <div class="modal-title">上传音视频</div>
    <div class="dropzone" id="dz">将音频/视频文件拖到此处，或 <b>点击选择</b><div class="hint">支持 mp3 / m4a / wav / mp4 / webm 等常见格式，长视频建议先用 tiny 模型测试速度</div></div>
    <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.m4a,.wav,.mp4,.webm,.aac,.ogg" hidden>
    <div class="modal-foot"><span class="spacer"></span><button class="btn btn-ghost" id="up-cancel">取消</button></div>
  `);
  const dz = $('#dz', root), fi = $('#file-input', root);
  dz.onclick = () => fi.click();
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) start(e.dataTransfer.files[0]); };
  fi.onchange = () => fi.files[0] && start(fi.files[0]);
  $('#up-cancel', root).onclick = closeModal;
  async function start(file) {
    closeModal();
    const n = await db.put({ id: uid(), kind: 'file', title: file.name, createdAt: Date.now(), status: 'working', _file: undefined });
    pendingFiles.set(n.id, file);
    location.hash = '#/resource/' + n.id;
    await refreshNotes();
    runFilePipeline(n.id, file);
  }
}
const pendingFiles = new Map();

function noteModal() {
  const root = openModal(`
    <div class="modal-title">新建笔记</div>
    <div class="field"><input type="text" id="note-title" placeholder="标题"></div>
    <textarea id="note-content" rows="8" placeholder="记录灵感…（保存后可用 AI 整理）"></textarea>
    <div class="modal-foot"><span class="spacer"></span><button class="btn btn-ghost" id="note-cancel">取消</button><button class="btn btn-primary" id="note-ok">保存</button></div>
  `);
  $('#note-cancel', root).onclick = closeModal;
  $('#note-title', root).focus();
  $('#note-ok', root).onclick = async () => {
    const title = $('#note-title', root).value.trim() || '未命名笔记';
    const contentMd = $('#note-content', root).value;
    if (!contentMd.trim()) return toast('内容不能为空', true);
    closeModal();
    const n = await db.put({ id: uid(), kind: 'note', title, contentMd, createdAt: Date.now(), status: 'ready' });
    location.hash = '#/resource/' + n.id;
  };
}

/* ================= 解析流水线 ================= */
async function runLinkPipeline(id) {
  if (runningPipelines.has(id)) return;
  runningPipelines.add(id);
  const note = await db.get(id);
  const pl = platformOf(note.sourceUrl);
  const articleRe = /mp\.weixin\.qq\.com|zhihu\.com|zhuanlan|juejin\.cn|csdn\.net|cnblogs\.com|jianshu\.com|medium\.com|substack\.com|\.html?($|\?)/i;
  const videoPl = ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'tiktok', 'instagram', 'twitter'].includes(pl);
  try {
    if (!videoPl && articleRe.test(note.sourceUrl)) {
      await runArticlePipeline(id);
    } else {
      try {
        await runVideoPipeline(id);
        return;
      } catch (e) {
        const cur = await db.get(id);
        // 视频解析失败 → 可能是图文帖（抖音/小红书图文），回退到正文抓取
        if (!cur.transcript && !cur.contentMd) {
          await db.patch(id, { status: 'working', aiError: '' });
          await runArticlePipeline(id);
          return;
        }
        throw e;
      }
    }
  } catch (e) {
    stepSetFor(id, null, 'err', String(e.message || e).slice(0, 200));
    await db.patch(id, { status: 'error', aiError: String(e.message || e).slice(0, 300) });
  } finally { runningPipelines.delete(id); }
}
function stepSetFor(id, name, status, msg, progress) {
  if (currentId !== id) return;
  if (name == null) { // 全部步骤标错
    stepState.steps.forEach(s => { if (s.status === 'active') { s.status = 'err'; s.msg = msg; } });
    renderSteps(); return;
  }
  stepSet(name, status, msg, progress);
}

/* --- 视频/音频链接：解析 → 平台字幕 + Whisper 双轨 → 声纹 → AI --- */
async function runVideoPipeline(id, retry = false) {
  const note0 = await db.get(id);
  // 懒迁移：旧笔记只有 transcript+transcriptSource，按来源拆到 transcriptSubs/transcriptWhisper
  if (note0.transcript && !note0.transcriptSubs && !note0.transcriptWhisper) {
    const mig = note0.transcriptSource === 'subs' ? { transcriptSubs: note0.transcript }
      : note0.transcriptSource === 'whisper' ? { transcriptWhisper: note0.transcript } : null;
    if (mig) await db.patch(id, mig);
  }
  const noteMig = await db.get(id);
  const wantWhisper = S.alwaysWhisper || !noteMig.transcriptSubs;
  const diaStep = S.diarize ? [{ name: 'diar', label: '声纹识别', status: 'pending', msg: '' }] : [];
  setSteps(id, [
    { name: 'resolve', label: '解析链接', status: noteMig.platform && !retry ? 'done' : 'active', msg: '' },
    { name: 'subs', label: '获取字幕', status: noteMig.transcriptSubs ? 'done' : (noteMig.subsTried ? 'skip' : 'active'), msg: '' },
    { name: 'audio', label: '下载音频', status: noteMig.mediaFile ? 'done' : (wantWhisper ? 'pending' : 'skip'), msg: wantWhisper ? '' : '已关闭，仅用平台字幕' },
    { name: 'asr', label: '语音转写', status: noteMig.transcriptWhisper ? 'done' : (wantWhisper ? 'pending' : 'skip'), msg: '' },
    ...diaStep,
    { name: 'ai', label: 'AI 翻译/总结', status: 'pending', msg: '' },
  ]);
  try {
    if (!noteMig.platform || retry) {
      const info = await api('/api/resolve', { url: noteMig.sourceUrl });
      const pk = platformOf(info.webpage_url || noteMig.sourceUrl);
      await db.patch(id, {
        title: info.title, uploader: info.uploader, duration: info.duration || 0,
        thumbnail: info.thumbnail || '', platform: pk, sourceUrl: info.webpage_url || noteMig.sourceUrl,
        desc: info.description || '',
      });
      stepSetFor(id, 'resolve', 'done', info.platform);
      updateDetailHeader();
    }
    let note = await db.get(id);

    if (!note.transcriptSubs && !note.subsTried) {
      try {
        const r = await api('/api/subs', { url: note.sourceUrl });
        if (r.segments && r.segments.length >= 2) {
          const patch = { transcriptSubs: r.segments, duration: note.duration || r.segments[r.segments.length - 1].e };
          if (!note.transcript) { patch.transcript = r.segments; patch.transcriptSource = 'subs'; }
          await db.patch(id, patch);
          stepSetFor(id, 'subs', 'done', `平台字幕 ${r.count} 条`);
        } else throw new Error('empty');
      } catch (e) {
        await db.patch(id, { subsTried: true });
        stepSetFor(id, 'subs', 'skip', wantWhisper ? '无可用字幕，转百炼' : '无可用字幕');
      }
    }
    note = await db.get(id);

    const needWhisper = S.alwaysWhisper || !note.transcriptSubs;
    if (!needWhisper) {
      stepSetFor(id, 'audio', 'skip', '已关闭，仅用平台字幕');
      stepSetFor(id, 'asr', 'skip', '已关闭，仅用平台字幕');
    } else if (!note.transcriptWhisper) {
      let mediaFile = note.mediaFile;
      if (!mediaFile) {
        stepSetFor(id, 'audio', 'active', '排队中…', 0);
        const job = await api('/api/download', { url: note.sourceUrl });
        mediaFile = await pollJob(job.id, p => stepSetFor(id, 'audio', 'active', p.file ? '' : `${Math.round(p.progress)}%`, p.progress / 100));
        await db.patch(id, { mediaFile });
        updateDetailHeader();
      }
      stepSetFor(id, 'audio', 'done', '');
      stepSetFor(id, 'asr', 'active', '读取音频…', 0);
      const blob = await fetchWithProgress(mediaUrl(mediaFile), p => stepSetFor(id, 'asr', 'active', '读取音频…', p * 0.15));
      const { audio } = await decodeAudio(blob);
      stepSetFor(id, 'asr', 'active', '准备百炼音频转写…', 0.15);
      const segs = await transcribe(audio, {
        onProgress: (p, m) => stepSetFor(id, 'asr', 'active', m, 0.15 + p * 0.85),
        onDownload: d => stepSetFor(id, 'asr', 'active', d.phase + (d.progress != null ? ` ${Math.round(d.progress * 100)}%` : ''), 0.15 + (d.progress || 0) * 0.1),
      });
      if (!segs.length) throw new Error('转写结果为空（音频可能没有语音内容）');
      const cur = await db.get(id);
      const patch = { transcriptWhisper: segs, duration: cur.duration || (segs[segs.length - 1].e || 0) };
      // primary transcript: 平台字幕优先；缺失时 Whisper 顶上
      if (!cur.transcriptSubs) { patch.transcript = segs; patch.transcriptSource = 'whisper'; }
      await db.patch(id, patch);
      stepSetFor(id, 'asr', 'done', `${segs.length} 段${cur.transcriptSubs ? '（与平台字幕并列保存）' : ''}`);
    } else {
      stepSetFor(id, 'asr', 'done', `${note.transcriptWhisper.length} 段`);
    }
    if (S.diarize) await runDiarize(id);
    await runAiSteps(id, 'ai');
  } catch (e) {
    stepSetFor(id, null, 'err', String(e.message || e).slice(0, 200));
    await db.patch(id, { status: 'error', aiError: String(e.message || e).slice(0, 300) });
    renderErrorBox();
  }
}

/* --- 声纹识别（说话人分离） --- */
const audioCache = new Map();
const SPK_COLORS = ['#ff6e1e', '#3b82f6', '#22a55b', '#8b5cf6', '#e11d48', '#0ea5e9', '#d97706', '#14b8a6'];
const spkColor = i => SPK_COLORS[(i - 1 + SPK_COLORS.length * 8) % SPK_COLORS.length];

async function getNoteAudio(n) {
  if (audioCache.has(n.id)) return audioCache.get(n.id);
  const f = pendingFiles.get(n.id);
  if (f) return (await decodeAudio(f)).audio;
  if (n.mediaFile) {
    const r = await fetch(mediaUrl(n.mediaFile));
    if (!r.ok) return null;
    return (await decodeAudio(await r.blob())).audio;
  }
  return null;
}

async function runDiarize(id, stepName = 'diar') {
  const n = await db.get(id);
  if (!n.transcript || n.transcript.length < 2) { stepSetFor(id, stepName, 'skip', '段落过少'); return; }
  const dur = n.duration || n.transcript[n.transcript.length - 1].e || 0;
  if (dur > 45 * 60) { stepSetFor(id, stepName, 'skip', '音频过长，已跳过'); return; }
  stepSetFor(id, stepName, 'active', '获取音频…', 0.04);
  let audio = null;
  try { audio = await getNoteAudio(n); } catch {}
  if (!audio || !audio.length) { stepSetFor(id, stepName, 'skip', '无音频可分析'); return; }
  try {
    const r = await diarize(audio, n.transcript, {
      onProgress: (p, m) => stepSetFor(id, stepName, 'active', m, 0.1 + p * 0.9),
      onDownload: d => stepSetFor(id, stepName, 'active', d.phase + (d.progress != null && d.progress < 1 ? ` ${Math.round(d.progress * 100)}%` : ''), 0.1),
    });
    const patch = { transcript: r.segments, speakerCount: r.speakers };
    if (n.transcriptSource === 'subs') patch.transcriptSubs = r.segments;
    else if (n.transcriptSource === 'whisper') patch.transcriptWhisper = r.segments;
    await db.patch(id, patch);
    stepSetFor(id, stepName, 'done', `${r.speakers} 位说话人`);
    if (currentId === id) renderDetail();
  } catch (e) {
    stepSetFor(id, stepName, 'err', '声纹识别失败：' + String(e.message || e).slice(0, 80));
  }
}

/* 逐字稿合并为文本（多说话人时带标签，供 LLM 使用） */
function transcriptText(n) {
  if (!n.transcript) return n.contentMd || '';
  const multi = (n.speakerCount || 1) > 1;
  return n.transcript.map(s => multi ? `说话人${s.spk || 1}: ${s.t}` : s.t).join('\n');
}

/* AI 总结输入：两份转写都存在时并列喂给 LLM 让它综合参考，否则退回单源 */
function aiInputText(n) {
  if (!n.transcriptSubs || !n.transcriptWhisper) return transcriptText(n);
  const fmt = (segs, tagged) => segs.map(s => tagged ? `说话人${s.spk || 1}: ${s.t}` : s.t).join('\n');
  const subsTagged = (n.speakerCount || 1) > 1 && n.transcriptSource === 'subs';
  const whTagged = (n.speakerCount || 1) > 1 && n.transcriptSource === 'whisper';
  return `【平台字幕版】\n${fmt(n.transcriptSubs, subsTagged)}\n\n【语音转写版】\n${fmt(n.transcriptWhisper, whTagged)}\n\n（上面是同一段音视频的两份转写：平台字幕通常标点和专有名词更准，语音转写覆盖更完整但可能识别错误。请综合两版理解内容。）`;
}

/* 连续同一说话人的段落合并为"气泡组" */
function speakerRuns(tr) {
  const runs = []; let cur = null;
  tr.forEach((s, i) => {
    const k = s.spk || 1;
    if (!cur || cur.spk !== k) { cur = { spk: k, idx: [] }; runs.push(cur); }
    cur.idx.push(i);
  });
  return runs;
}

async function pollJob(jobId, onProgress) {  for (;;) {
    await new Promise(r => setTimeout(r, 1200));
    const r = await fetch(S.serverUrl.replace(/\/$/, '') + '/api/job/' + jobId, {
      headers: S.accessToken ? { 'x-access-token': S.accessToken } : {},
    });
    const j = await r.json();
    if (j.status === 'done') return j.file;
    if (j.status === 'error') throw new Error(j.error || '音频下载失败');
    onProgress && onProgress(j);
  }
}

async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('媒体文件获取失败 HTTP ' + r.status);
  const total = +r.headers.get('Content-Length') || 0;
  if (!r.body) return await r.blob();
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress && onProgress(total ? got / total : 0);
  }
  return new Blob(chunks);
}

/* --- 图文链接 --- */
async function runArticlePipeline(id) {
  const note0 = await db.get(id);
  setSteps(id, [
    { name: 'fetch', label: '抓取正文', status: note0.contentMd ? 'done' : 'active', msg: '' },
    { name: 'ai', label: 'AI 翻译/总结', status: 'pending', msg: '' },
  ]);
  try {
    if (!note0.contentMd) {
      const r = await api('/api/article', { url: note0.sourceUrl });
      await db.patch(id, { kind: 'article', title: r.title, contentMd: r.text, thumbnail: r.cover || '', platform: platformOf(note0.sourceUrl), uploader: r.site });
      stepSetFor(id, 'fetch', 'done', `${r.text.length} 字`);
      updateDetailHeader();
    }
    await runAiSteps(id, 'ai');
  } catch (e) {
    stepSetFor(id, null, 'err', String(e.message || e).slice(0, 200));
    await db.patch(id, { status: 'error', aiError: String(e.message || e).slice(0, 300) });
    renderErrorBox();
  }
}

/* --- 本地文件 --- */
async function runFilePipeline(id, file) {
  file = file || pendingFiles.get(id);
  pendingFiles.delete(id);
  setSteps(id, [
    { name: 'asr', label: '语音转写', status: 'active', msg: '读取文件…', progress: 0 },
    ...(S.diarize ? [{ name: 'diar', label: '声纹识别', status: 'pending', msg: '' }] : []),
    { name: 'ai', label: 'AI 翻译/总结', status: 'pending', msg: '' },
  ]);
  try {
    if (!(await db.get(id)).transcript) {
      const { audio, duration } = await decodeAudio(file);
      audioCache.set(id, audio);
      const segs = await transcribe(audio, {
        onProgress: (p, m) => stepSetFor(id, 'asr', 'active', m, 0.05 + p * 0.95),
        onDownload: d => stepSetFor(id, 'asr', 'active', d.phase + (d.progress != null ? ` ${Math.round(d.progress * 100)}%` : ''), 0.05 + (d.progress || 0) * 0.1),
      });
      if (!segs.length) throw new Error('转写结果为空（文件里可能没有语音）');
      await db.patch(id, { transcript: segs, transcriptSource: 'whisper', transcriptWhisper: segs, duration: duration || (segs[segs.length - 1].e || 0) });
      stepSetFor(id, 'asr', 'done', `${segs.length} 段`);
    }
    if (S.diarize) await runDiarize(id);
    await runAiSteps(id, 'ai');
  } catch (e) {
    stepSetFor(id, null, 'err', String(e.message || e).slice(0, 200));
    await db.patch(id, { status: 'error', aiError: String(e.message || e).slice(0, 300) });
    renderErrorBox();
  }
}

/* --- AI 步骤：翻译 + 总结 --- */
async function runAiSteps(id, stepName) {
  const note = await db.get(id);
  const baseText = transcriptText(note);
  if (!baseText.trim()) { stepSetFor(id, stepName, 'skip', '无文本'); await db.patch(id, { status: 'ready' }); return; }

  if (!llmReady()) {
    stepSetFor(id, stepName, 'pending', '未配置 API Key');
    await db.patch(id, { status: 'ready', needKey: true });
    renderKeyHint();
    return;
  }
  stepSetFor(id, stepName, 'active', '分析语言…', 0);
  const lang = detectLang(baseText);
  await db.patch(id, { lang, needKey: false });
  // 翻译规则：en-skip（默认）= 英语不翻译、其他外语翻译；all = 全部翻译；off = 不翻译
  const skipEn = S.translateMode === 'en-skip' && lang === 'en';
  const needTranslate = lang !== 'zh' && !skipEn && S.translateMode !== 'off';

  if (needTranslate && !note.translation && !note.translationMd) {
    if (note.transcript) {
      const tr = await translateSegments(note.transcript, {
        onProgress: (p, m) => stepSetFor(id, stepName, 'active', m, p * 0.45),
      });
      await db.patch(id, { translation: tr, translationSource: note.transcriptSource || 'whisper' });
    } else {
      const md = await translateText(note.contentMd, {
        onProgress: (p, m) => stepSetFor(id, stepName, 'active', m, p * 0.45),
      });
      await db.patch(id, { translationMd: md });
    }
    stepSetFor(id, stepName, 'active', `已翻译（${LANG_NAMES[lang] || lang} → 中文）`, 0.45);
    if (currentId === id) renderDetail();
  } else {
    const msg = lang === 'zh' ? '中文内容，跳过翻译'
      : skipEn ? '英语内容，按要求跳过翻译'
      : S.translateMode === 'off' ? '已关闭自动翻译'
      : '翻译已存在';
    stepSetFor(id, stepName, 'active', msg, 0.4);
  }

  // 总结（流式写入）：双源并列时把两份都喂给 LLM 综合参考
  const aiText = aiInputText(note);
  let live = '';
  try {
    const r = await summarizeLong(aiText, {
      onDelta: t => {
        live = t;
        const el = $('#md-summary');
        if (el && currentId === id && $('#tab-summary')?.classList.contains('active')) el.innerHTML = renderMd(live);
      },
      onThinking: n => stepSetFor(id, stepName, 'active', `模型思考中…（已推理 ${n} 字）`, 0.46),
      onProgress: (p, m) => stepSetFor(id, stepName, 'active', m, 0.45 + p * 0.5),
    });
    await db.patch(id, { summaryMd: r.summaryMd, tags: r.tags, status: 'ready' });
    stepSetFor(id, stepName, 'done', '完成');
    if (currentId === id) renderDetail();
  } catch (e) {
    if (live) await db.patch(id, { summaryMd: live, status: 'ready' });
    stepSetFor(id, stepName, 'err', String(e.message || e).slice(0, 150));
    await db.patch(id, { aiError: String(e.message || e).slice(0, 300) });
  }
}

/* ================= 详情页 ================= */
let activeTab = 'main';
async function renderDetail() {
  const n = await db.get(currentId);
  if (!n) { location.hash = '#/workbench'; return; }
  const translationMatches = !n.translationSource || n.translationSource === n.transcriptSource;
  const hasTranslation = !!(n.translation || n.translationMd) && translationMatches;
  const mainLabel = n.kind === 'article' ? '原文' : '转写';
  const srcDot = n.transcriptViewMode === 'dual' ? ' <span class="dot">对照</span>'
    : n.transcriptSource === 'subs' ? ' <span class="dot">CC</span>'
    : n.transcriptSource === 'whisper' ? ' <span class="dot">ASR</span>' : '';
  main.innerHTML = `<div class="col" style="max-width:760px">
    <div class="topbar">
      <button class="back-btn" id="btn-back">${icon('back')}</button>
      <div class="topbar-title">${esc(n.title || '未命名')}</div>
      <button class="icon-btn" id="btn-chat" title="AI 对话">${icon('sparkle')}</button>
      <button class="icon-btn" id="btn-export" title="导出 Markdown">${icon('download')}</button>
      <button class="icon-btn" id="btn-del" title="删除">${icon('trash')}</button>
    </div>

    ${n.sourceUrl ? sourceCardHtml(n) : ''}
    ${n.mediaFile ? `<div class="audiobar"><audio controls style="flex:1" src="${esc(mediaUrl(n.mediaFile))}"></audio></div>` : ''}

    <div id="workpanel" class="workpanel" hidden></div>
    <div id="keyhint" hidden></div>

    <div class="tabs">
      <button class="tab active" data-tab="main">${mainLabel}${srcDot}</button>
      ${hasTranslation ? `<button class="tab" data-tab="trans"><span class="dot">译</span> 中文翻译</button>` : ''}
      <button class="tab" data-tab="summary"><span class="dot">✦</span> 智能总结</button>
    </div>
    <div id="tab-main"></div>
    <div id="tab-trans" hidden></div>
    <div id="tab-summary" hidden></div>
  </div>`;

  $('#btn-back').onclick = () => { if (history.length > 1) history.back(); else location.hash = '#/workbench'; };
  $('#btn-del').onclick = async () => {
    if (!confirm('确定删除这条资料？')) return;
    await db.del(n.id);
    toast('已删除');
    location.hash = '#/workbench';
  };
  $('#btn-export').onclick = () => exportNoteMd(await2(n));
  $('#btn-chat').onclick = () => openChat(n);

  $$('.tab').forEach(t => t.onclick = () => {
    activeTab = t.dataset.tab;
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('#tab-main').hidden = activeTab !== 'main';
    $('#tab-trans').hidden = activeTab !== 'trans';
    $('#tab-summary').hidden = activeTab !== 'summary';
    if (activeTab === 'summary' && !$('#md-summary') && n.summaryMd) renderSummaryTab(await2(n));
  });

  renderTabMain(n);
  if (hasTranslation) renderTabTrans(n);
  if (n.summaryMd) renderSummaryTab(n);
  if (stepState.noteId === n.id) renderSteps();
  if (n.status === 'error') renderErrorBox();
  if (n.needKey) {
    if (n.summaryMd) db.patch(n.id, { needKey: false });               // 已有总结，残留标记直接清掉
    else if (llmReady()) { db.patch(n.id, { needKey: false }); renderCta(); }  // 已配置 Key → 显示一键生成
    else renderKeyHint();                                              // 未配置 → 提示去设置
  }

  // 处理中断自动恢复（页面刷新后回到详情页时继续）
  if (n.status === 'working' && !runningPipelines.has(n.id)) {
    if (n.kind === 'file') {
      const f = pendingFiles.get(n.id);
      if (f) runFilePipeline(n.id, f);
      else { db.patch(n.id, { status: 'error', aiError: '处理中断：本地文件已丢失，请重新上传' }).then(renderErrorBox); }
    } else if (n.kind === 'video' && !n.transcript && !n.summaryMd) {
      runLinkPipeline(n.id);
    } else if (n.kind === 'article' && !n.contentMd && !n.summaryMd) {
      runLinkPipeline(n.id);
    }
  }
}
const await2 = x => x; // 直读（renderDetail 内已持有 note）

function sourceCardHtml(n) {
  const pm = platformMeta(n.platform || platformOf(n.sourceUrl));
  return `<a class="source-card" href="${esc(n.sourceUrl)}" target="_blank" rel="noopener">
    ${n.thumbnail ? `<img class="source-thumb" src="${esc(n.thumbnail)}" referrerpolicy="no-referrer" onerror="this.remove()">` : `<div class="source-ic" style="background:${pm.color}">${esc(pm.letter)}</div>`}
    <div class="source-main">
      <div class="source-title">${esc(n.title || n.sourceUrl)}</div>
      <div class="source-sub"><span>${esc(pm.name)}</span>${n.uploader ? `<span>${esc(n.uploader)}</span>` : ''}${n.duration ? `<span>${fmtDur(n.duration)}</span>` : ''}</div>
    </div>
    <span class="source-open">${icon('ext')}</span>
  </a>`;
}

function renderTabMain(n) {
  const el = $('#tab-main');
  if (n.kind === 'note') {
    el.innerHTML = `<textarea id="note-editor" style="width:100%;min-height:340px;border:1px solid var(--border);border-radius:12px;padding:14px;background:#fff;outline:none;font-family:inherit;font-size:14px;line-height:1.7" >${esc(n.contentMd || '')}</textarea>
      <div class="modal-foot"><button class="btn btn-ghost btn-sm" id="note-save">保存</button><span class="spacer"></span><button class="btn btn-accent btn-sm" id="note-polish">${icon('sparkle')} AI 整理</button></div>`;
    $('#note-save').onclick = async () => { await db.patch(n.id, { contentMd: $('#note-editor').value }); toast('已保存'); };
    $('#note-polish').onclick = async () => {
      if (!llmReady()) return toast('请先在设置中配置 AI API Key', true);
      toast('AI 整理中…');
      try {
        const md = await polishNote($('#note-editor').value);
        $('#note-editor').value = md;
        await db.patch(n.id, { contentMd: md });
        toast('整理完成');
      } catch (e) { toast(String(e.message || e), true); }
    };
    return;
  }
  if (n.contentMd) { el.innerHTML = `<div class="md" id="md-content">${renderMd(n.contentMd)}</div>`; return; }
  if (n.transcript) {
    migrateDualTranscript(n);
    const multi = (n.speakerCount || 1) > 1;
    const hasDual = !!(n.transcriptSubs && n.transcriptWhisper);
    const dual = hasDual && n.transcriptViewMode === 'dual';
    el.innerHTML = `
      <div class="trans-toolbar">
        ${n.kind !== 'article' ? `<button class="btn btn-ghost btn-sm" id="btn-diar">${icon('mic')} 声纹识别说话人</button>` : ''}
        ${hasDual ? sourceSwitchHtml(n) : ''}
        <span class="hint-inline">${multi ? `${n.speakerCount} 位说话人 · 点击名字可重命名` : '点击名字可重命名 · 点击时间跳转播放'}</span>
      </div>
      ${dual ? dualTranscriptHtml(n) : `<div class="transcript">${runsHtml(n, false)}</div>`}`;
    bindTranscript(el, n);
    if (hasDual) bindSourceSwitch(el, n);
    return;
  }
  el.innerHTML = `<div class="empty"><div class="empty-ic">⏳</div>内容处理中…</div>`;
}

/* 老笔记：只有 transcript + transcriptSource 时，把内容镜像到对应的来源字段，方便切换 UI 出现 */
function migrateDualTranscript(n) {
  if (!n.transcript || n.transcriptSubs || n.transcriptWhisper) return;
  const patch = n.transcriptSource === 'subs' ? { transcriptSubs: n.transcript }
    : n.transcriptSource === 'whisper' ? { transcriptWhisper: n.transcript } : null;
  if (patch) db.patch(n.id, patch);
}

function sourceSwitchHtml(n) {
  const mode = n.transcriptViewMode || n.transcriptSource || 'whisper';
  const b = (v, label) => `<button class="btn btn-sm src-btn ${mode === v ? 'btn-accent' : 'btn-ghost'}" data-src-mode="${v}" style="padding:2px 10px;font-size:12px">${label}</button>`;
  return `<span class="src-switch" style="display:inline-flex;gap:2px;background:rgba(0,0,0,0.05);padding:2px;border-radius:8px">${b('subs', '平台字幕')}${b('whisper', '语音转写')}${b('dual', '对照')}</span>`;
}

function bindSourceSwitch(el, n) {
  $$('.src-btn', el).forEach(b => b.onclick = async () => {
    const mode = b.dataset.srcMode;
    const patch = { transcriptViewMode: mode };
    if (mode === 'subs' && n.transcriptSubs) { patch.transcript = n.transcriptSubs; patch.transcriptSource = 'subs'; }
    else if (mode === 'whisper' && n.transcriptWhisper) { patch.transcript = n.transcriptWhisper; patch.transcriptSource = 'whisper'; }
    await db.patch(n.id, patch);
    renderDetail();
  });
}

/* 双显对照：平台字幕 vs Whisper 并排显示，点击时间跳转播放 */
function dualTranscriptHtml(n) {
  const col = (title, segs) => `<div class="dual-col" style="min-width:0">
    <div style="font-size:12px;color:var(--text2);padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:8px">${title}（${segs.length} 段）</div>
    <div class="transcript" style="padding:0">${segs.map(s => `<div class="seg-line"><span class="seg-time-mini" data-t="${s.s}">${fmtClock(s.s)}</span><span class="seg-text">${esc(s.t)}</span></div>`).join('')}</div>
  </div>`;
  return `<div class="dual-wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    ${col('平台字幕', n.transcriptSubs || [])}
    ${col('语音转写', n.transcriptWhisper || [])}
  </div>`;
}

/* 逐字稿 HTML：按说话人分组，连续同一人只显示一次头像/名字 */
function runsHtml(n, translated) {
  const names = n.speakerNames || {};
  return speakerRuns(n.transcript).map(run => {
    const first = n.transcript[run.idx[0]];
    return `<div class="seg-run">
      <div class="seg-head">
        <div class="seg-sp" style="background:${spkColor(run.spk)}" data-spk="${run.spk}" title="点击重命名">${run.spk}</div>
        <span class="seg-name" data-spk="${run.spk}" title="点击重命名">${esc(names[run.spk] || `说话人 ${run.spk}`)}</span>
        <span class="seg-time" data-t="${first.s}">${fmtClock(first.s)}</span>
      </div>
      ${run.idx.map(i => {
        const s = n.transcript[i];
        const t = translated && n.translation ? (n.translation[i] ?? s.t) : s.t;
        return `<div class="seg-line"><span class="seg-time-mini" data-t="${s.s}">${fmtClock(s.s)}</span><span class="seg-text">${esc(t)}</span></div>`;
      }).join('')}
    </div>`;
  }).join('');
}

function bindTranscript(el, n) {
  const seek = t => { const a = $('audio'); if (a) { a.currentTime = t; a.play(); } };
  $$('.seg-time, .seg-time-mini', el).forEach(x => x.onclick = () => seek(+x.dataset.t));
  const rename = async spk => {
    const names = { ...(n.speakerNames || {}) };
    const v = prompt(`给「说话人 ${spk}」起个名字（留空恢复默认）：`, names[spk] || '');
    if (v === null) return;
    if (v.trim()) names[spk] = v.trim(); else delete names[spk];
    n.speakerNames = names;
    await db.patch(n.id, { speakerNames: names });
    renderDetail();
  };
  $$('.seg-sp, .seg-name', el).forEach(x => x.onclick = () => rename(+x.dataset.spk));
  const bd = $('#btn-diar', el);
  if (bd) bd.onclick = async () => {
    bd.disabled = true; bd.textContent = '识别中…';
    setSteps(n.id, [{ name: 'diar', label: '声纹识别', status: 'active', msg: '' }]);
    await runDiarize(n.id);
    setTimeout(() => {
      if (stepState.noteId === n.id && stepState.steps.length === 1 && stepState.steps[0].name === 'diar') {
        stepState.steps = []; renderSteps();
      }
    }, 1200);
  };
}

function renderTabTrans(n) {
  const el = $('#tab-trans');
  if (n.translation) {
    el.innerHTML = `<div class="transcript">${runsHtml(n, true)}</div>`;
    $$('.seg-time, .seg-time-mini', el).forEach(x => x.onclick = () => { const a = $('audio'); if (a) { a.currentTime = +x.dataset.t; a.play(); } });
  } else if (n.translationMd) {
    el.innerHTML = `<div class="md">${renderMd(n.translationMd)}</div>`;
  }
}

function renderSummaryTab(n) {
  const el = $('#tab-summary');
  el.innerHTML = `
    ${(n.tags && n.tags.length) ? `<div class="tag-row">${n.tags.map(t => `<a class="tag-chip" href="#/tags/${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    <div class="md" id="md-summary">${renderMd(n.summaryMd || '')}</div>
    <div style="margin-top:22px;display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" id="sum-copy">复制总结</button>
      <button class="btn btn-ghost btn-sm" id="sum-redo">重新总结</button>
    </div>`;
  $('#sum-copy').onclick = () => { navigator.clipboard.writeText(n.summaryMd || ''); toast('已复制'); };
  $('#sum-redo').onclick = async () => {
    if (!llmReady()) return toast('请先配置 AI API Key', true);
    await db.patch(n.id, { summaryMd: '', aiError: '' });
    if (currentId === n.id) { stepState.noteId = n.id; if (!stepState.steps.find(s => s.name === 'ai')) setSteps(n.id, [{ name: 'ai', label: 'AI 翻译/总结', status: 'active' }]); }
    runAiSteps(n.id, 'ai');
  };
}

function renderErrorBox() {
  const box = $('#keyhint'); if (!box) return;
  db.get(currentId).then(nn => {
    if (!nn || !nn.aiError || nn.aiError.includes('未配置')) return;
    box.hidden = false;
    box.innerHTML = `<div class="workpanel" style="border-color:#f4b8b1"><div class="wp-title" style="color:#d92d20">⚠ 处理失败</div>
      <div style="font-size:13px;color:var(--text2);line-height:1.7">${esc(nn.aiError)}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        ${nn.transcript || nn.contentMd ? `<button class="btn btn-accent btn-sm" id="err-ai">重试 AI 步骤</button>` : ''}
        ${(nn.sourceUrl && !nn.transcript) ? `<button class="btn btn-primary btn-sm" id="err-retry">重新解析</button>` : ''}
      </div></div>`;
    const ra = $('#err-ai'), rr = $('#err-retry');
    if (ra) ra.onclick = async () => { await db.patch(currentId, { aiError: '' }); box.hidden = true; setSteps(currentId, [{ name: 'ai', label: 'AI 翻译/总结', status: 'active' }]); runAiSteps(currentId, 'ai'); };
    if (rr) rr.onclick = async () => { await db.patch(currentId, { subsTried: false, mediaFile: null, aiError: '', transcript: null }); box.hidden = true; runVideoPipeline(currentId, true); };
  });
}

function renderKeyHint() {
  const box = $('#keyhint'); if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="workpanel"><div class="wp-title">🔑 配置 AI 后可自动翻译 + 总结</div>
    <div style="font-size:13px;color:var(--text2)">在设置中填写 OpenAI 兼容 API（智谱 glm-4-flash 免费）。逐字稿已保存，随时可以回来生成总结。</div>
    <div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="location.hash='#/settings'">去设置</button></div></div>`;
}

/* 已配置 Key 但还没生成总结的笔记：给一键生成入口 */
function renderCta() {
  const box = $('#keyhint'); if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="workpanel"><div class="wp-title">${icon('sparkle')} AI 已就绪</div>
    <div style="font-size:13px;color:var(--text2)">这份内容还没有生成总结，点击一键完成翻译（如需）+ 智能总结。</div>
    <div style="margin-top:10px"><button class="btn btn-accent btn-sm" id="cta-run">生成 AI 翻译/总结</button></div></div>`;
  $('#cta-run').onclick = async () => {
    box.hidden = true;
    setSteps(currentId, [{ name: 'ai', label: 'AI 翻译/总结', status: 'active', msg: '' }]);
    runAiSteps(currentId, 'ai');
  };
}

function updateDetailHeader() {
  if (currentId) db.get(currentId).then(n => { if (n && currentId === n.id) { const t = $('.topbar-title'); if (t) t.textContent = n.title || '未命名'; const sc = $('.source-card'); if (sc) sc.outerHTML = sourceCardHtml(n); } });
}

/* ---------- 导出 ---------- */
function exportNoteMd(n) {
  const pm = platformMeta(n.platform || 'generic');
  let md = `# ${n.title || '未命名'}\n\n`;
  md += `> 来源：${n.sourceUrl ? `[${n.sourceUrl}](${n.sourceUrl})` : '本地'} · ${pm.name} · ${fmtDate(n.createdAt)}${n.duration ? ` · ${fmtDur(n.duration)}` : ''}\n\n`;
  if (n.summaryMd) md += `## AI 总结\n\n${n.summaryMd}\n\n`;
  if (n.translationMd) md += `## 中文翻译\n\n${n.translationMd}\n\n`;
  if (n.translation) md += `## 中文翻译\n\n` + n.transcript.map((s, i) => `[${fmtClock(s.s)}] ${n.translation[i] ?? s.t}`).join('\n') + '\n\n';
  if (n.contentMd) md += `## 原文\n\n${n.contentMd}\n\n`;
  if (n.transcript) md += `## 逐字稿\n\n` + n.transcript.map(s => `[${fmtClock(s.s)}] ${s.t}`).join('\n') + '\n';
  download((n.title || 'note').replace(/[\\/:*?"<>|]/g, '_') + '.md', md);
}

/* ================= AI 对话抽屉 ================= */
function openChat(n) {
  $('#drawer-root').innerHTML = `
    <div class="drawer-mask" id="dw-mask"></div>
    <div class="drawer">
      <div class="drawer-head">${icon('sparkle')} AI 对话<button class="modal-x" id="dw-x">✕</button></div>
      <div class="chat-body" id="chat-body">
        <div class="msg ai">可以问我关于「${esc((n.title || '').slice(0, 20))}」的任何问题，我会基于它的内容回答。</div>
      </div>
      <div class="chat-input">
        <textarea id="chat-inp" placeholder="输入问题，回车发送"></textarea>
        <button class="btn btn-accent" id="chat-send">发送</button>
      </div>
    </div>`;
  const body = $('#chat-body');
  $('#dw-mask').onclick = closeChat;
  $('#dw-x').onclick = closeChat;
  const inp = $('#chat-inp');
  inp.focus();
  const send = async () => {
    const q = inp.value.trim();
    if (!q) return;
    if (!llmReady()) { toast('请先配置 AI API Key', true); return; }
    inp.value = '';
    body.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div>`);
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    aiMsg.innerHTML = '<span style="color:var(--text3)">思考中…</span>';
    body.appendChild(aiMsg);
    body.scrollTop = body.scrollHeight;
    const hist = chatHistories.get(n.id) || [];
    try {
      const context = (n.summaryMd ? n.summaryMd + '\n\n' : '') +
        (n.transcript ? transcriptText(n) : (n.contentMd || ''));
      const full = await chatWith(hist, context, q, { onDelta: t => { aiMsg.innerHTML = renderMd(t); body.scrollTop = body.scrollHeight; } });
      hist.push({ role: 'user', content: q }, { role: 'assistant', content: full });
      chatHistories.set(n.id, hist.slice(-12));
    } catch (e) {
      aiMsg.textContent = '出错了：' + String(e.message || e).slice(0, 150);
    }
  };
  $('#chat-send').onclick = send;
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
}
function closeChat() { $('#drawer-root').innerHTML = ''; }

/* ================= 实时录音 ================= */
let recState = null;
function renderRecord() {
  main.innerHTML = `<div class="col">
    <div class="rec-hero">
      <button class="rec-btn" id="rec-btn">${icon('mic')}</button>
      <div class="rec-timer" id="rec-timer">00:00</div>
      <div class="rec-hint" id="rec-hint">点击开始现场录音，自动实时转写</div>
    </div>
    <div class="rec-live" id="rec-live" hidden>
      <div class="sec-title" style="margin-top:0"><span class="rec-dot"></span>实时转写</div>
      <div class="transcript" id="rec-segs"></div>
    </div>
  </div>`;
  $('#rec-btn').onclick = () => recState ? stopRec() : startRec();
}
async function startRec() {
  if (!navigator.mediaDevices) return toast('无法访问麦克风', true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('麦克风权限被拒绝', true); }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  const all = [];   // 完整留档，供声纹识别
  proc.onaudioprocess = e => { const c = new Float32Array(e.inputBuffer.getChannelData(0)); chunks.push(c); all.push(c); };
  src.connect(proc);
  const silent = ctx.createGain(); silent.gain.value = 0;
  proc.connect(silent); silent.connect(ctx.destination);

  recState = { stream, ctx, proc, src, chunks, all, segs: [], startAt: Date.now(), busy: false, consumed: 0, timer: setInterval(updateTimer, 500), lastLen: 0 };
  $('#rec-btn').classList.add('stop');
  $('#rec-btn').innerHTML = icon('stop');
  $('#rec-hint').textContent = '录音中，再次点击结束并保存';
  $('#rec-live').hidden = false;
  toast('开始录音');

  const MODEL = S.whisperModel;
  recState.pump = setInterval(async () => {
    const st = recState;
    if (!st || st.busy) return;
    const len = st.chunks.reduce((a, c) => a + c.length, 0);
    if (len - st.consumed < 16000 * 14) return; // 每 ~14s 处理一次
    st.busy = true;
    const piece = [];
    let take = len - st.consumed;
    while (take > 0 && st.chunks.length) {
      const c = st.chunks.shift();
      piece.push(c); take -= c.length;
    }
    const audio = concatFloat32(piece);
    st.consumed += audio.length;
    const offset = st.lastLen;
    st.lastLen += audio.length;
    try {
      const segs = await transcribe(audio, { modelKey: MODEL });
      for (const sg of segs) {
        st.segs.push({ s: (sg.s + offset / 16000), e: sg.e + offset / 16000, t: sg.t });
      }
      renderRecSegs();
    } catch (e) { console.warn(e); }
    st.busy = false;
  }, 3000);
}
function concatFloat32(arr) {
  const len = arr.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of arr) { out.set(c, o); o += c.length; }
  return out;
}
function updateTimer() {
  if (!recState) return;
  const el = $('#rec-timer');
  if (el) el.textContent = fmtClock((Date.now() - recState.startAt) / 1000);
}
function renderRecSegs() {
  const el = $('#rec-segs');
  if (!el || !recState) return;
  el.innerHTML = recState.segs.map(s => `
    <div class="seg"><div class="seg-body">
      <div class="seg-meta"><span>说话人 1</span><span class="seg-time">${fmtClock(s.s)}</span></div>
      <div class="seg-text">${esc(s.t)}</div>
    </div></div>`).join('');
  el.parentElement.parentElement.scrollTop = 1e9;
}
async function stopRec() {
  const st = recState;
  if (!st) return;
  clearInterval(st.timer);
  if (st.pump) clearInterval(st.pump);
  try { st.proc.disconnect(); st.src && st.src.disconnect(); st.ctx.close(); st.stream.getTracks().forEach(t => t.stop()); } catch {}
  $('#rec-hint').textContent = '正在完成音频转写…';
  while (st.busy) await new Promise(resolve => setTimeout(resolve, 100));
  // 处理剩余音频
  const restLen = st.chunks.reduce((a, c) => a + c.length, 0);
  if (restLen > 16000 * 0.5) {
    const audio = concatFloat32(st.chunks.splice(0));
    const offset = st.lastLen;
    try {
      const segs = await transcribe(audio, { modelKey: S.whisperModel });
      for (const sg of segs) st.segs.push({ s: sg.s + offset / 16000, e: sg.e + offset / 16000, t: sg.t });
    } catch {}
  }
  recState = null;
  $('#rec-btn').classList.remove('stop');
  $('#rec-btn').innerHTML = icon('mic');
  if (!st.segs.length) { toast('没有录到语音内容', true); $('#rec-hint').textContent = '点击开始现场录音，自动实时转写'; $('#rec-live').hidden = true; return; }
  const dur = st.lastLen / 16000;
  const n = await db.put({
    id: uid(), kind: 'record', title: `现场录音 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
    transcript: st.segs, transcriptWhisper: st.segs, transcriptSource: 'whisper', duration: Math.round(dur), createdAt: Date.now(), status: 'working',
  });
  if (S.diarize && st.all.length) audioCache.set(n.id, concatFloat32(st.all));
  location.hash = '#/resource/' + n.id;
  await refreshNotes();
  setSteps(n.id, [
    ...(S.diarize ? [{ name: 'diar', label: '声纹识别', status: 'active', msg: '' }] : []),
    { name: 'ai', label: 'AI 翻译/总结', status: 'pending', msg: '' },
  ]);
  if (S.diarize) await runDiarize(n.id);
  runAiSteps(n.id, 'ai');
}

/* ================= 设置页 ================= */
function renderSettings() {
  const health = fetch(S.serverUrl.replace(/\/$/, '') + '/api/health').then(r => r.json()).catch(() => null);
  main.innerHTML = `<div class="settings-wrap">
    <div class="sec-title" style="margin-top:0">设置</div>

    <div class="set-card">
      <h3>AI 服务（OpenAI 兼容）</h3>
      <div class="desc">用于翻译和总结。推荐智谱 glm-4-flash（免费）；也支持 DeepSeek / OpenAI / OpenRouter 等</div>
      <div class="field"><label>API 地址 Base URL</label><input type="text" id="set-base" value="${esc(S.llmBase)}"></div>
      <div class="row2">
        <div class="field"><label>API Key ${S.useServerKey ? '（已存服务端，浏览器不含明文）' : ''}</label><input type="password" id="set-key" value="${esc(S.llmKey)}" placeholder="${S.useServerKey ? '已由服务端提供' : '粘贴你的 Key'}" autocomplete="off" ${S.useServerKey ? 'disabled' : ''}></div>
        <div class="field"><label>模型</label><input type="text" id="set-model" value="${esc(S.llmModel)}"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-accent btn-sm" id="set-test">测试连接</button>
        <button class="btn btn-primary btn-sm" id="set-savekey">${S.useServerKey ? '更新服务端 Key' : '把 Key 保存到本地服务（推荐）'}</button>
        <span id="set-srvkey-status" style="font-size:12px;color:var(--text3)">检查中…</span>
      </div>
      <div class="field" style="margin-top:14px"><label>访问令牌（防止他人调用你的 Key）</label>
        <div class="row2">
          <input type="password" id="set-token" value="${esc(S.accessToken)}" placeholder="服务端设置了令牌后必填" autocomplete="off">
          <button class="btn btn-ghost btn-sm" id="set-settoken" style="white-space:nowrap">把令牌写入服务端</button>
        </div>
        <div class="hint">🔒 安全模型：Key 推荐只保存在本地服务端（data/config.json，已被 .gitignore 排除，GitHub 扫描机器人不可能碰到）；浏览器只存访问令牌——拿到令牌才能用你的 Key，泄漏了随时在服务端换一个。首次使用：填好 Key → 点「保存到本地服务」→ 想一个令牌填入并点「把令牌写入服务端」。其他设备只需填同一个令牌。</div>
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="set-viaserver" ${S.llmViaServer ? 'checked' : ''}><label for="set-viaserver" style="margin:0">通过本地服务转发请求（推荐，避免 CORS）</label>
      </div>
      <span id="set-test-result" style="font-size:12px;color:var(--text3)"></span>
    </div>

    <div class="set-card">
      <h3>语音转写（百炼云端）</h3>
      <div class="desc">仅上传音频，不上传视频画面。密钥由服务端保管；北京地域新人免费额度 10 小时，有效期 90 天，请在百炼控制台确认额度并开启“免费额度用完即停”。</div>
      <div class="field"><label>音频转写模型</label><select id="set-whisper" disabled>
        ${Object.entries(MODELS).map(([k, v]) => `<option value="${k}" ${S.whisperModel === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select></div>
      <div class="row2">
        <div class="field"><label>音频语言</label><select id="set-lang">
          ${[['auto', '自动检测'], ['zh', '中文'], ['en', '英语'], ['id', '印尼语'], ['ja', '日语'], ['ko', '韩语'], ['vi', '越南语'], ['th', '泰语'], ['es', '西班牙语'], ['ru', '俄语']].map(([k, v]) => `<option value="${k}" ${S.audioLang === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field" style="display:flex;align-items:center;gap:8px;padding-top:22px">
          <input type="checkbox" id="set-hfmirror" ${S.hfMirror ? 'checked' : ''}><label for="set-hfmirror" style="margin:0">本地声纹模型下载失败时用镜像</label>
        </div>
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="set-diar" ${S.diarize ? 'checked' : ''}><label for="set-diar" style="margin:0">可选：本地声纹识别说话人（仍需下载约 6MB 模型，关闭后不下载）</label>
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="set-alwayswhisper" ${S.alwaysWhisper ? 'checked' : ''}><label for="set-alwayswhisper" style="margin:0">即使拿到平台字幕也使用百炼转写音频（两份并列保存，AI 总结时综合参考；会消耗语音免费额度）</label>
      </div>
      <div class="field"><label>外语翻译规则</label><select id="set-tmode">
        ${[['en-skip', '自动总结；英语不翻译，其他外语翻译成中文（推荐）'], ['all', '所有外语都翻译成中文'], ['off', '全部不翻译，只总结']].map(([k, v]) => `<option value="${k}" ${S.translateMode === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select><div class="hint">语言识别方式：中日韩按文字判断；英语与印尼语按功能词频率区分（印尼语的 yang/dan/tidak/itu 等在英语中几乎不出现）；西语、葡语、法语等归为"其他外语"，会翻译</div></div>
    </div>

    <div class="set-card">
      <h3>数据备份</h3>
      <div class="desc">笔记保存在浏览器 IndexedDB；开启自动备份后，每次变更会滚动备份到本地服务 data/backups/（保留最近 10 份）</div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="set-autobackup" ${S.autoBackup ? 'checked' : ''}><label for="set-autobackup" style="margin:0">自动备份到本地服务</label>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-ghost btn-sm" id="set-backup-now">立即备份</button>
        <span style="font-size:12px;color:var(--text3)">${S.lastBackupAt ? '上次备份：' + fmtDate(S.lastBackupAt) : '尚未备份过'}</span>
      </div>
    </div>

    <div class="set-card">
      <h3>本地服务 / 解析</h3>
      <div class="desc">yt-dlp 负责链接解析与音频下载。解析海外平台（YouTube/Instagram/X）时需要代理；国内平台建议留空</div>
      <div class="field"><label>服务地址</label><input type="text" id="set-server" value="${esc(S.serverUrl)}"></div>
      <div class="row2">
        <div class="field"><label>读取浏览器 Cookie（登录内容）</label><select id="set-cookies">
          ${[['', '不使用'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox']].map(([k, v]) => `<option value="${k}" ${S.cookiesBrowser === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>网络代理（可选）</label><input type="text" id="set-proxy" value="${esc(S.proxy || '')}" placeholder="http://127.0.0.1:7890"></div>
      </div>
      <div id="srv-status" style="font-size:12px;color:var(--text3)">检查服务中…</div>
      <div class="hint">两种模式：① 本机服务 — 地址填 http://127.0.0.1:5218（github.io 前端则填 https://127.0.0.1:5219 并先信任一次证书）；② 云端服务 — 地址填你的 Render 地址（https://xxx.onrender.com，部署方法见项目 README），电脑关机也能用。密钥在云端用环境变量 LLM_KEY / ACCESS_TOKEN 配置。</div>
    </div>
  </div>`;

  health.then(h => {
    const el = $('#srv-status');
    if (!h) { if (el) el.innerHTML = '<span style="color:#d92d20">⚠ 无法连接本地服务，请确认已运行 node server.js</span>'; return; }
    Object.assign(S, { cookiesBrowser: h.config?.cookiesBrowser ?? S.cookiesBrowser, proxy: h.config?.proxy ?? S.proxy });
    if (el) el.textContent = `✅ 服务正常 · yt-dlp ${h.ytDlp || '缺失'} · ffmpeg ${h.ffmpeg ? 'OK' : '缺失（无法转码音频）'}`;
    $('#set-cookies').value = S.cookiesBrowser || '';
    $('#set-proxy').value = S.proxy || '';
    const ks = $('#set-srvkey-status');
    if (ks) {
      ks.innerHTML = h.config?.hasKey
        ? '<span style="color:#22a55b">✓ 服务端已保存 Key</span>'
        : '<span style="color:#ad6800">服务端还没有 Key</span>';
    }
    if (h.config?.hasToken && !S.accessToken) {
      const ti = $('#set-token');
      if (ti) ti.placeholder = '服务端已设令牌，此处必填';
    }
    // 服务端有 Key（本机保存或云端 LLM_KEY）且浏览器没有 → 自动启用并同步 UI
    if (h.config?.hasKey && !S.llmKey && !S.useServerKey) {
      Object.assign(S, saveS({ useServerKey: true }));
      const ki = $('#set-key');
      if (ki) { ki.disabled = true; ki.value = ''; ki.placeholder = '已由服务端提供'; }
      const bk = $('#set-savekey');
      if (bk) bk.textContent = '更新服务端 Key';
    }
  });

  const collect = () => saveS({
    llmBase: $('#set-base').value.trim(), llmKey: $('#set-key').disabled ? '' : $('#set-key').value.trim(), llmModel: $('#set-model').value.trim(),
    llmViaServer: $('#set-viaserver').checked, whisperModel: $('#set-whisper').value, audioLang: $('#set-lang').value,
    hfMirror: $('#set-hfmirror').checked, translateMode: $('#set-tmode').value, diarize: $('#set-diar').checked,
    alwaysWhisper: $('#set-alwayswhisper').checked,
    accessToken: $('#set-token').value.trim(), autoBackup: $('#set-autobackup').checked,
    serverUrl: $('#set-server').value.trim().replace(/\/$/, ''),
  });
  // 任意修改即保存
  $$('.settings-wrap input, .settings-wrap select').forEach(el => el.onchange = () => {
    collect();
    api('/api/config', { cookiesBrowser: $('#set-cookies')?.value ?? '', proxy: $('#set-proxy')?.value ?? '' })
      .catch(e => toast('服务端配置保存失败：' + String(e.message || e).slice(0, 60), true));
  });

  const withTokenHeaders = extra => ({ 'Content-Type': 'application/json', ...(S.accessToken ? { 'x-access-token': S.accessToken } : {}), ...extra });

  $('#set-savekey').onclick = async () => {
    const el = $('#set-srvkey-status');
    try {
      const key = $('#set-key').disabled ? '' : $('#set-key').value.trim();
      if (!key && !S.useServerKey) return toast('请先粘贴 Key', true);
      const r = await fetch(S.serverUrl.replace(/\/$/, '') + '/api/config', {
        method: 'POST', headers: withTokenHeaders(), body: JSON.stringify({ llmKey: key || undefined, ...(key ? {} : {}) }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      if (key) { saveS({ llmKey: '', useServerKey: true }); $('#set-key').value = ''; $('#set-key').disabled = true; $('#set-key').placeholder = '已由服务端提供'; $('#set-savekey').textContent = '更新服务端 Key'; }
      el.innerHTML = '<span style="color:#22a55b">✓ 服务端已保存 Key</span>';
      toast('Key 已保存到本地服务（浏览器不再保留明文）');
    } catch (e) { el.textContent = ''; toast('保存失败：' + String(e.message || e).slice(0, 80), true); }
  };

  $('#set-settoken').onclick = async () => {
    const t = $('#set-token').value.trim();
    if (!t) return toast('先想一个令牌填入（随意的一串字符）', true);
    try {
      const r = await fetch(S.serverUrl.replace(/\/$/, '') + '/api/config', {
        method: 'POST', headers: withTokenHeaders(), body: JSON.stringify({ accessToken: t }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      saveS({ accessToken: t });
      toast('令牌已写入服务端，本浏览器已保存');
    } catch (e) { toast('写入失败：' + String(e.message || e).slice(0, 80), true); }
  };

  $('#set-backup-now').onclick = () => doBackup(true);

  $('#set-test').onclick = async () => {
    collect();
    const el = $('#set-test-result');
    el.textContent = '测试中…';
    try {
      const r = await fetch(S.serverUrl.replace(/\/$/, '') + '/api/llm', {
        method: 'POST', headers: withTokenHeaders(),
        body: JSON.stringify({ baseUrl: S.llmBase, model: S.llmModel, messages: [{ role: 'user', content: '回复 OK 两个字母即可' }], max_tokens: 512 }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      const msg = j.choices?.[0]?.message || {};
      el.textContent = '✅ 连接成功：' + (msg.content || (msg.reasoning_content ? '（推理模型，已连通）' : '')).slice(0, 40);
      el.style.color = '#22a55b';
    } catch (e) {
      el.textContent = '❌ ' + String(e.message || e).slice(0, 120);
      el.style.color = '#d92d20';
    }
  };
}

/* ================= 侧边栏 ================= */
$('#btn-settings').onclick = () => location.hash = '#/settings';
$('#btn-record-nav').onclick = () => location.hash = '#/record';
$('#btn-export-data').onclick = async () => {
  const data = await exportAll();
  download(`leanin-backup-${new Date().toISOString().slice(0, 10)}.json`, data, 'application/json');
  toast('已导出全部数据');
};
$('#btn-import-data').onclick = () => $('#import-file').click();
$('#import-file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const count = await importAll(await f.text());
    toast(`已导入 ${count} 条资料`);
    route();
  } catch (err) { toast('导入失败：' + err.message, true); }
  e.target.value = '';
};

/* 横幅 */
if (!S.bannerDismissed) $('#banner').hidden = false;
$('#banner-close').onclick = () => { $('#banner').hidden = true; saveS({ bannerDismissed: true }); };

/* ---------- 自动备份到本地服务（滚动 10 份） ---------- */
let backupTimer = null;
let backingUp = false;
async function doBackup(manual = false) {
  if (backingUp) return;
  backingUp = true;
  try {
    const data = await exportAll();
    await api('/api/backup', { data });
    saveS({ lastBackupAt: Date.now() });
    if (manual) toast('已备份到本地服务');
  } catch (e) {
    if (manual) toast('备份失败：' + String(e.message || e).slice(0, 60), true);
  } finally { backingUp = false; }
}
window.addEventListener('leanin-notes-changed', () => {
  if (!S.autoBackup) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => doBackup(false), 15000);   // 变更停止 15 秒后备份
});

/* 启动 */
route();

/* 静态托管/云端模式：检测服务连通性并提示 */
if (location.protocol === 'https:') {
  const isCloud = !/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i.test(S.serverUrl);
  fetch(S.serverUrl.replace(/\/$/, '') + '/api/health')
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(h => {
      // 服务端（本机保存或云端环境变量）已有 Key 而本浏览器没有 → 自动启用"用服务端 Key"
      if (h.config?.hasKey && !S.llmKey && !S.useServerKey) { Object.assign(S, saveSettings({ useServerKey: true })); }
      $('#banner-text').textContent = isCloud
        ? `✅ 后端：云端服务 ${S.serverUrl} （电脑关机也能用）· 数据只存你的浏览器 · 改地址去「设置」`
        : `✅ 后端：本机服务 ${S.serverUrl} （需要这台电脑开着）· 想关机也能用：设置里把服务地址改成 Render 地址`;
      $('#banner').hidden = false;
    })
    .catch(() => {
      $('#banner-text').innerHTML = isCloud
        ? '⚠ 无法连接云端服务：免费实例闲置 15 分钟后会休眠，首次访问冷启动需 30~60 秒，请稍等再刷新。若持续失败请检查 Render 控制台。'
        : '⚠ 静态托管前端需要后端服务：① 运行 start.bat 并在浏览器信任一次 https://127.0.0.1:5219 证书；或 ② 在设置里把服务地址改成你的 Render 云端地址（部署方法见项目 README）。API Key 需在本页设置中重新填写一次。';
      $('#banner').hidden = false;
    });
}
