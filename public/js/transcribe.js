/* 百炼音频转写：浏览器仅解码音频，密钥与云端调用由服务端管理 */
import { getSettings } from './db.js';

export const MODELS = {
  bailian: { id: 'qwen3-asr-flash-filetrans', label: '百炼千问音频转写（云端，无需下载模型）' },
};

let worker = null;


function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  }
  return worker;
}

/* 文件/Blob → 16kHz 单声道 Float32（AudioContext 仅存在于主线程） */
export async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  let ab;
  try { ab = await ctx.decodeAudioData(buf); }
  finally { try { ctx.close(); } catch {} }
  let audio;
  if (ab.numberOfChannels === 1) audio = ab.getChannelData(0);
  else {
    audio = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < ab.length; i++) audio[i] += d[i] / ab.numberOfChannels;
    }
  }
  return { audio, duration: ab.duration };
}

/* 音频编码为单声道 WAV；不会上传视频画面或向浏览器下发密钥。 */
export async function transcribe(audio, { onProgress } = {}) {
  if (!audio?.length) throw new Error('音频为空');
  if (audio.length * 2 + 44 > 512 * 1024 * 1024) throw new Error('音频过长，请分段后重试（单次最多约 4.6 小时）');
  const data = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(data);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  const settings = getSettings();
  const base = settings.serverUrl.replace(/\/$/, '');
  const auth = settings.accessToken ? { 'x-access-token': settings.accessToken } : {};
  async function request(url, contentType, body) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': contentType, ...auth }, body, signal: AbortSignal.timeout(150000) });
    let result;
    try { result = await response.json(); } catch { throw new Error('转写服务响应异常（HTTP ' + response.status + '）'); }
    if (!response.ok || result.error) throw new Error(result.error || '转写服务请求失败');
    return result;
  }
  onProgress?.(0.05, '上传音频至百炼…');
  const job = await request('/api/asr?language=' + encodeURIComponent(settings.audioLang || 'auto'), 'audio/wav', data);
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await request('/api/asr/status', 'application/json', JSON.stringify({ id: job.id }));
    if (result.status === 'SUCCEEDED') { onProgress?.(1, '百炼转写完成'); return result.segments; }
    onProgress?.(0.5, result.status === 'PENDING' ? '百炼排队中…' : '百炼正在转写音频…');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('百炼转写等待超时，请稍后重试');
}

/* 声纹识别：给逐字稿段落标注说话人（worker 线程，pyannote） */
export function diarize(audio, segments, { onProgress, onDownload } = {}) {
  return workerTask({ type: 'diarize', audio, segments, hfMirror: getSettings().hfMirror }, {
    onMessage: (d, api) => {
      if (d.type === 'model') onDownload && onDownload({ phase: d.phase + (d.progress != null && d.progress < 1 ? ` ${Math.round(d.progress * 100)}%` : ''), progress: d.progress });
      else if (d.type === 'diaprog') onProgress && onProgress(d.done / d.total, `声纹分析 ${d.done}/${d.total} 窗口`);
      else if (d.type === 'diadone') { onProgress && onProgress(1, '完成'); api.resolve({ segments: d.segments, speakers: d.speakers }); }
    },
  });
}

/* 共用：向 Worker 派发任务并等待结果 */
let jobSeq = 0;
function workerTask(payload, { onMessage }) {
  const w = getWorker();
  const jobId = ++jobSeq;
  return new Promise((resolve, reject) => {
    const onMsg = e => {
      const d = e.data || {};
      if (d.jobId !== jobId) return;
      let settled = false;
      const api = {
        resolve: v => { settled = true; cleanup(); resolve(v); },
        reject: err => { settled = true; cleanup(); reject(err); },
      };
      onMessage(d, api);
      if (d.type === 'error' && !settled) { cleanup(); reject(new Error(d.message)); }
    };
    const onErr = err => { cleanup(); reject(new Error('转写线程异常：' + String(err?.message || err).slice(0, 200))); };
    function cleanup() { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); }
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ ...payload, jobId });
  });
}
