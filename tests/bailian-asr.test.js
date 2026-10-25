'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsr } = require('../bailian-asr');
function wav() {
  const b = Buffer.alloc(32044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
test('audio upload, async polling, timestamps and secret isolation', async () => {
  const calls = [];
  const asr = createAsr(() => 'private-test-key', async (url, options) => {
    calls.push({ url, options });
    switch (calls.length) {
      case 1: return response({ data: { upload_host: 'https://upload.oss-cn-beijing.aliyuncs.com', upload_dir: 'private', oss_access_key_id: 'upload-secret', signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } });
      case 2:
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.body.get('file').type, 'audio/wav');
        return new Response('', { status: 200 });
      case 3:
        assert.equal(options.headers.Authorization, 'Bearer private-test-key');
        assert.equal(options.headers['X-DashScope-OssResourceResolve'], 'enable');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'qwen3-asr-flash-filetrans');
        assert.equal(body.parameters.language, 'zh');
        assert.deepEqual(body.parameters.channel_id, [0]);
        assert.match(body.input.file_url, /^oss:\/\/private\/.+\.wav$/);
        return response({ output: { task_id: 'cloud-task' } });
      case 4: return response({ output: { task_status: 'RUNNING' } });
      case 5: return response({ output: { task_status: 'SUCCEEDED', result: { transcription_url: 'http://result.oss-cn-beijing.aliyuncs.com/result.json?signature=private' } } });
      case 6:
        assert.equal(options.headers.Authorization, undefined);
        assert.match(url, /^https:/);
        return response({ transcripts: [{ sentences: [{ begin_time: 1200, end_time: 2400, text: ' 测试。 ' }] }] });
      default: throw new Error('Unexpected request');
    }
  });
  const job = await asr.submit(wav(), 'zh');
  assert.notEqual(job.id, 'cloud-task');
  assert.deepEqual(await asr.poll(job.id), { status: 'RUNNING' });
  const result = await asr.poll(job.id);
  assert.deepEqual(result, { status: 'SUCCEEDED', segments: [{ s: 1.2, e: 2.4, t: '测试。' }] });
  assert.doesNotMatch(JSON.stringify({ job, result }), /private|signature|cloud-task/);
  assert.deepEqual(await asr.poll(job.id), result);
  assert.equal(calls.length, 6);
});
test('rejects video, invalid language, missing key and unknown task without upload', async () => {
  const asr = createAsr(() => 'key', async () => { throw new Error('must not request'); });
  await assert.rejects(asr.submit(Buffer.from('video payload')), /仅支持/);
  await assert.rejects(asr.submit(wav(), 'invalid'), /不支持/);
  await assert.rejects(asr.poll('unknown'), /不存在/);
  await assert.rejects(createAsr(() => '').submit(wav()), /请在服务端/);
});
test('permission and network errors never return provider secrets', async () => {
  const denied = createAsr(() => 'secret', async () => new Response('secret upstream echo', { status: 403 }));
  await assert.rejects(denied.submit(wav()), e => /HTTP 403/.test(e.message) && !/secret/.test(e.message));
  const network = createAsr(() => 'secret', async () => { throw new Error('Authorization Bearer secret'); });
  await assert.rejects(network.submit(wav()), e => /网络/.test(e.message) && !/secret/.test(e.message));
});
test('browser sends only PCM audio and access token, without loading a local model', async () => {
  const originalFetch = global.fetch;
  const originalWorker = global.Worker;
  global.location = { hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:5218' };
  global.localStorage = { getItem: () => JSON.stringify({ whisperModel: 'base', diarize: true, accessToken: 'local-access', audioLang: 'zh' }) };
  global.Worker = class { constructor() { throw new Error('Must not load a local model'); } };
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['x-access-token'], 'local-access');
    if (calls === 1) {
      assert.equal(url, 'http://127.0.0.1:5218/api/asr?language=zh');
      assert.equal(options.headers['Content-Type'], 'audio/wav');
      const b = Buffer.from(options.body);
      assert.equal(b.toString('ascii', 0, 4), 'RIFF');
      assert.equal(b.readUInt16LE(22), 1);
      assert.equal(b.readUInt32LE(24), 16000);
      assert.equal(b.readInt16LE(44), -32768);
      assert.equal(b.readInt16LE(48), 32767);
      return response({ id: 'local-task' });
    }
    assert.equal(url, 'http://127.0.0.1:5218/api/asr/status');
    assert.deepEqual(JSON.parse(options.body), { id: 'local-task' });
    return response({ status: 'SUCCEEDED', segments: [{ s: 0, e: 1, t: '测试。' }] });
  };
  try {
    const { pathToFileURL } = require('node:url');
    const path = require('node:path');
    const { transcribe } = await import(pathToFileURL(path.join(__dirname, '../public/js/transcribe.js')).href);
    const { getSettings } = await import(pathToFileURL(path.join(__dirname, '../public/js/db.js')).href);
    assert.equal(getSettings().diarize, false);
    assert.equal(getSettings().whisperModel, 'bailian');
    assert.deepEqual(await transcribe(new Float32Array([-2, 0, 2])), [{ s: 0, e: 1, t: '测试。' }]);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    global.Worker = originalWorker;
    delete global.location;
    delete global.localStorage;
  }
});
