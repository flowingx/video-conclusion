'use strict';
const crypto = require('node:crypto');
const MODEL = 'qwen3-asr-flash-filetrans';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;

function createAsr(getKey, request = fetch, base = BASE) {
  const endpoint = new URL(base);
  if (endpoint.protocol !== 'https:' || (endpoint.hostname !== 'dashscope.aliyuncs.com' && !endpoint.hostname.endsWith('.cn-beijing.maas.aliyuncs.com'))) throw new Error('百炼服务地址必须为北京地域官方域名');
  const tasks = new Map();
  async function call(url, options = {}, authenticated = true) {
    try {
      const response = await request(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { ...(authenticated ? { Authorization: 'Bearer ' + getKey() } : {}), ...options.headers },
      });
      if (!response.ok) {
        const hint = response.status === 401 ? '请检查服务端百炼密钥及地域' :
          response.status === 403 ? '请检查模型权限、免费额度及用完即停设置' :
          response.status === 429 ? '请求过于频繁，请稍后重试' : '请稍后重试';
        throw new Error(`百炼请求失败（HTTP ${response.status}）：${hint}`);
      }
      return response;
    } catch (e) {
      // 不透传上游正文、URL、上传凭证或请求头，避免密钥随异常泄露。
      if (e.message.startsWith('百炼请求失败（HTTP ')) throw e;
      throw new Error('百炼网络请求失败，请检查网络后重试');
    }
  }
  async function json(url, options, authenticated) {
    const response = await call(url, options, authenticated);
    try { return await response.json(); }
    catch { throw new Error('百炼返回了无效响应'); }
  }
  return {
    async submit(audio, language = 'auto') {
      if (!getKey()) throw new Error('请在服务端配置 DASHSCOPE_API_KEY 或 data/bailian-key.txt');
      if (!Buffer.isBuffer(audio) || audio.length <= 44 || audio.length > MAX_AUDIO_BYTES ||
          audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' ||
          audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16 ||
          audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
          audio.readUInt32LE(24) !== 16000 || audio.readUInt16LE(34) !== 16 ||
          audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44) {
        throw new Error('仅支持不超过 512MB 的 16kHz 单声道 PCM16 WAV 音频');
      }
      const allowed = ['auto','zh','yue','en','ja','de','ko','ru','fr','pt','ar','it','es','hi','id','th','tr','uk','vi','cs','da','fil','fi','is','ms','no','pl','sv'];
      if (!allowed.includes(language)) throw new Error('不支持的音频语言');
      const policy = (await json(`${base}/uploads?action=getPolicy&model=${MODEL}`)).data;
      if (!policy?.upload_host || !policy.upload_dir) throw new Error('百炼未返回上传凭证');
      const host = new URL(policy.upload_host);
      if (host.protocol !== 'https:' || !host.hostname.endsWith('.aliyuncs.com')) throw new Error('百炼上传地址无效');
      const name = crypto.randomUUID() + '.wav';
      const key = policy.upload_dir + '/' + name;
      const form = new FormData();
      for (const [field, value] of Object.entries({
        OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
        'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
        key, success_action_status: '200',
      })) form.append(field, value);
      form.append('file', new Blob([audio], { type: 'audio/wav' }), name);
      await call(host.href, { method: 'POST', body: form }, false);
      const data = await json(`${base}/services/audio/asr/transcription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
        body: JSON.stringify({ model: MODEL, input: { file_url: 'oss://' + key },
          parameters: { channel_id: [0], enable_words: true, ...(language !== 'auto' ? { language } : {}) } }),
      });
      if (!data.output?.task_id) throw new Error('百炼未返回转写任务，请检查模型权限');
      for (const [id, task] of tasks) if (Date.now() - task.createdAt > 86400000) tasks.delete(id);
      const id = crypto.randomUUID();
      tasks.set(id, { upstreamId: data.output.task_id, createdAt: Date.now() });
      return { id, status: 'PENDING' };
    },
    async poll(id) {
      const task = tasks.get(id);
      if (!task || Date.now() - task.createdAt > 86400000) throw new Error('转写任务不存在或已过期，请重新转写');
      if (task.result) return task.result;
      const data = await json(`${base}/tasks/${encodeURIComponent(task.upstreamId)}`);
      const output = data.output;
      if (['PENDING', 'RUNNING'].includes(output?.task_status)) return { status: output.task_status };
      if (output?.task_status !== 'SUCCEEDED') throw new Error('百炼转写失败，请检查音频、模型权限及免费额度');
      const url = new URL(output.result?.transcription_url);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.endsWith('.aliyuncs.com')) throw new Error('百炼结果地址无效');
      url.protocol = 'https:';
      const result = await json(url.href, {}, false);
      const segments = (result.transcripts || []).flatMap(t => t.sentences || [])
        .filter(s => typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.begin_time) && Number.isFinite(s.end_time))
        .map(s => ({ s: Math.max(0, s.begin_time / 1000), e: Math.max(0, s.end_time / 1000), t: s.text.trim() }));
      task.result = { status: 'SUCCEEDED', segments };
      return task.result;
    },
  };
}
module.exports = { createAsr, MODEL, MAX_AUDIO_BYTES };
