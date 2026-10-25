/* 可选本地声纹识别 Worker；语音转写由百炼服务端完成 */
import { AutoModel, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

env.allowLocalModels = false;
env.useBrowserCache = true;

const HOSTS = m => m
  ? ['https://hf-mirror.com', 'https://huggingface.co']
  : ['https://huggingface.co', 'https://hf-mirror.com'];

let diaModel = null;

/* ---------------- 声纹分割（pyannote segmentation-3.0） ---------------- */
const SR = 16000, WIN = 160000, HOP = 128000, GRID = 0.02; // 10s 窗口 8s 步进，20ms 全局网格

async function ensureDia(hfMirror) {
  if (diaModel) return diaModel;
  let lastErr = null;
  for (const host of HOSTS(hfMirror)) {
    try {
      env.remoteHost = host;
      post({ type: 'model', phase: '加载声纹模型', progress: 0 });
      diaModel = await AutoModel.from_pretrained('onnx-community/pyannote-segmentation-3.0', {
        dtype: 'fp32',
        progress_callback: msg => {
          if (msg.status === 'progress' && msg.total) {
            post({ type: 'model', phase: '下载声纹模型', progress: (msg.progress || 0) / 100 });
          }
        },
      });
      return diaModel;
    } catch (e) { lastErr = e; }
  }
  throw new Error('声纹模型加载失败：' + String(lastErr?.message || lastErr).slice(0, 150));
}

const sumArr = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

let __jobId = null;
const post = m => self.postMessage({ ...m, jobId: __jobId });

/* 解码一个 10s 窗口 → 3 个本地说话人的每帧激活概率 [0..1] */
function decodeWindow(logitsData, F, C) {
  const local = [new Float32Array(F), new Float32Array(F), new Float32Array(F)];
  const ex = new Float32Array(C);
  for (let f = 0; f < F; f++) {
    const base = f * C;
    let mx = -Infinity;
    for (let c = 0; c < C; c++) if (logitsData[base + c] > mx) mx = logitsData[base + c];
    let s = 0;
    for (let c = 0; c < C; c++) { ex[c] = Math.exp(logitsData[base + c] - mx); s += ex[c]; }
    // powerset 解码：config id2label → 类别 c 对应位掩码 (c+1)
    for (let i = 0; i < 3; i++) {
      let acc = 0;
      for (let c = 1; c < C; c++) if (((c + 1) >> i) & 1) acc += ex[c] / s;
      local[i][f] = acc;
    }
  }
  return local;
}

async function diarizeTask(audio, segments) {
  await ensureDia(globalThis.__hfMirror__);
  const durTotal = audio.length / SR;
  const wins = [];
  for (let st = 0; ; st += HOP) {
    const end = Math.min(st + WIN, audio.length);
    let chunk = audio.subarray(st, end);
    if (chunk.length < WIN) { const pad = new Float32Array(WIN); pad.set(chunk); chunk = pad; }
    wins.push({ t0: st / SR, dur: (end - st) / SR, chunk });
    if (end >= audio.length) break;
  }
  const G = Math.ceil(durTotal / GRID) + 2;
  const tracks = [];   // 每个全局说话人的激活轨迹
  let prev = null;     // 上一窗口（用于重叠区标签对齐）
  for (let wi = 0; wi < wins.length; wi++) {
    const w = wins[wi];
    const out = await diaModel({ input_values: new Tensor('float32', w.chunk, [1, 1, WIN]) });
    const logits = out.logits;
    const F = logits.dims[1], C = logits.dims[2];
    const local = decodeWindow(logits.data, F, C);
    const fdur = (WIN / SR) / F;
    const map = [-1, -1, -1];
    const overlapDur = prev ? Math.max(0, prev.t0 + prev.dur - w.t0) : 0;

    if (!prev) {
      const idx = [0, 1, 2].map(i => ({ i, act: sumArr(local[i]) * fdur }))
        .filter(x => x.act > 0.35).sort((a, b) => b.act - a.act);
      for (const x of idx) { map[x.i] = tracks.length; tracks.push(new Float32Array(G)); }
    } else {
      // 重叠区：把上一窗口的本地激活按其 global 映射累加，再与当前窗口各 local 算匹配分
      const ovF = Math.min(F, Math.ceil(overlapDur / fdur));
      const pg = tracks.map(() => new Float32Array(ovF));
      for (let li = 0; li < 3; li++) {
        const g = prev.map[li];
        if (g < 0) continue;
        for (let f = 0; f < ovF; f++) pg[g][f] += prev.local[li][f];
      }
      const scores = [];
      for (let li = 0; li < 3; li++) for (let g = 0; g < tracks.length; g++) {
        let s = 0;
        for (let f = 0; f < ovF; f++) s += Math.min(local[li][f], pg[g][f]);
        scores.push({ sc: s / Math.max(0.3, ovF * fdur), li, g });
      }
      scores.sort((a, b) => b.sc - a.sc);
      const usedL = new Set(), usedG = new Set();
      for (const x of scores) {
        if (x.sc < 0.1 || usedL.has(x.li) || usedG.has(x.g)) continue;
        map[x.li] = x.g; usedL.add(x.li); usedG.add(x.g);
      }
      for (let li = 0; li < 3; li++) {
        if (map[li] >= 0) continue;
        const act = sumArr(local[li]) * fdur;
        if (act > Math.max(0.5, w.dur * 0.05)) { map[li] = tracks.length; tracks.push(new Float32Array(G)); usedL.add(li); }
      }
    }
    // 写入全局轨迹（跳过与上一窗口重叠的部分；最后一个窗口全量写入）
    const skipF = (wi === wins.length - 1) ? 0 : Math.min(F, Math.ceil(overlapDur / fdur));
    for (let li = 0; li < 3; li++) {
      const g = map[li];
      if (g < 0) continue;
      const tr = tracks[g];
      for (let f = skipF; f < F; f++) {
        const t = w.t0 + f * fdur;
        if (t >= w.t0 + w.dur) break;
        const gi = Math.round(t / GRID);
        if (local[li][f] > tr[gi]) tr[gi] = local[li][f];
      }
    }
    prev = { t0: w.t0, dur: w.dur, local, map };
    post({ type: 'diaprog', done: wi + 1, total: wins.length });
  }
  // 过滤几乎不出声的"幽灵说话人"
  const act = tracks.map(tr => sumArr(tr) * GRID);
  const keep = [];
  act.forEach((s, g) => { if (s >= Math.max(2, durTotal * 0.01)) keep.push(g); });
  keep.sort((a, b) => act[b] - act[a]);
  const remap = new Map(keep.map((g, i) => [g, i + 1]));
  // 逐段分配说话人：取该时间段激活积分最高的全局说话人
  const outSegs = segments.map(seg => {
    let best = 0, bi = -1;
    for (const g of keep) {
      const tr = tracks[g];
      const i0 = Math.max(0, Math.floor(seg.s / GRID)), i1 = Math.min(G - 1, Math.ceil(seg.e / GRID));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += tr[i];
      if (s > best) { best = s; bi = g; }
    }
    return { ...seg, spk: bi >= 0 ? remap.get(bi) : 0 };
  });
  let last = 1;
  for (const seg of outSegs) { if (!seg.spk) seg.spk = last; last = seg.spk; }
  const used = new Set(outSegs.map(s => s.spk));
  return { segments: outSegs, speakers: Math.max(1, used.size) };
}

self.onmessage = async e => {
  const d = e.data || {};
  __jobId = d.jobId ?? null;
  try {
    if (d.type === 'diarize') { globalThis.__hfMirror__ = d.hfMirror; const r = await diarizeTask(d.audio, d.segments); post({ type: 'diadone', ...r }); }
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err).slice(0, 300) });
  }
};
