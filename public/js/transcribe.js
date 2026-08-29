/* 浏览器端 Whisper 转写：推理在 Web Worker 中执行，主线程只做音频解码与进度展示 */
import { getSettings } from './db.js';

export const MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', label: 'tiny（最快，~40MB，准确度一般）' },
  base: { id: 'onnx-community/whisper-base', label: 'base（推荐，~80MB）' },
  small: { id: 'onnx-community/whisper-small', label: 'small（较慢，~250MB，中文更准）' },
};

let worker = null;
export function isModelReady() { return !!worker; }

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

/* 转写：返回 [{s,e,t}]，推理在 Worker 线程 */
export async function transcribe(audio, { modelKey, onProgress, onDownload } = {}) {
  const modelId = MODELS[modelKey || getSettings().whisperModel].id;
  return workerTask({ type: 'run', audio, modelId, lang: getSettings().audioLang, hfMirror: getSettings().hfMirror }, {
    onMessage: (d, api) => {
      if (d.type === 'model') onDownload && onDownload({ phase: d.phase + (d.progress != null && d.progress < 1 ? ` ${Math.round(d.progress * 100)}%` : ''), progress: d.progress });
      else if (d.type === 'progress') onProgress && onProgress(d.total ? d.done / d.total : 0, d.done ? `转写中 ${d.done}/${d.total} 段` : '开始转写');
      else if (d.type === 'done') { onProgress && onProgress(1, '转写完成'); api.resolve(d.segments); }
    },
  });
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
