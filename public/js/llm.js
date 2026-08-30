/* LLM：摘要、翻译、笔记整理、对话（走本地服务转发，避免浏览器 CORS） */
import { getSettings } from './db.js';

async function chat(messages, { stream = false, onDelta = null, temperature = null, maxTokens = null } = {}) {
  const s = getSettings();
  if (!s.llmKey && !s.useServerKey) throw new Error('未配置 AI API Key，请在「设置」中填写');
  const r = await fetch(s.serverUrl.replace(/\/$/, '') + '/api/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.accessToken ? { 'x-access-token': s.accessToken } : {}),
    },
    body: JSON.stringify({
      baseUrl: s.llmBase, model: s.llmModel, messages, stream,
      ...(s.llmKey ? { apiKey: s.llmKey } : {}),   // 浏览器没存 Key 时由服务端注入
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  if (!stream) {
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('LLM 返回为空');
    return text;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onDelta && onDelta(full); }
      } catch {}
    }
  }
  if (!full) throw new Error('LLM 流式返回为空');
  return full;
}
export const llmReady = () => { const s = getSettings(); return !!(s.llmKey || s.useServerKey); };

/* ---------- AI 总结（复刻 Leanin 结构） ---------- */
const SUM_PROMPT = `你是一名专业的中文内容编辑。请为用户提供的内容生成深度总结，严格使用 Markdown 格式，结构如下：

# <8~16字的精炼标题>
<2~4句总体概述，关键概念用 **加粗**>

## 基本信息
- 📌 **主题**：一句话概括
- 👥 **主讲人/作者**：若无法判断写"未提及"
- 🎯 **目标**：内容想达成的目的

## 核心内容
1. **要点短语**：一句展开说明（共 5~8 条，按重要性排序）

## 详细内容
<分 3~6 个小节（用 ### 小节标题）展开，保留关键细节、数据、例子；适合用列表或表格的地方用列表/表格>

## 关键洞察
- **洞察句**：一句解释（共 3~6 条）

要求：
- 全文使用简体中文（即使原文是外语）
- 忠于原文，不编造内容
- 最后一行单独输出标签，格式为：TAGS: #标签1 #标签2 #标签3（标签为2~6字的内容关键词）`;

export async function summarize(content, { onDelta } = {}) {
  const text = await chat([
    { role: 'system', content: SUM_PROMPT },
    { role: 'user', content: `请总结以下内容：\n\n${content}` },
  ], { stream: true, onDelta, temperature: 0.3 });
  let tags = [];
  const m = /TAGS[:：]\s*(.+)$/m.exec(text);
  let body = text;
  if (m) {
    tags = m[1].split(/[\s#]+/).map(x => x.trim()).filter(Boolean).slice(0, 5);
    body = text.slice(0, m.index).trim();
  }
  return { summaryMd: body, tags };
}

/* 长文本分块摘要：先分段要点，再合并成结构 */
export async function summarizeLong(content, { onDelta, onProgress } = {}) {
  if (content.length <= 16000) return summarize(content, { onDelta });
  const CHUNK = 14000;
  const parts = [];
  for (let i = 0; i < content.length; i += CHUNK) parts.push(content.slice(i, i + CHUNK));
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress && onProgress(i / parts.length, `正在阅读第 ${i + 1}/${parts.length} 段`);
    const r = await chat([
      { role: 'system', content: '你是内容编辑。提取给定内容的所有关键信息：主题、论点、细节、数据、例子、结论。用简洁的中文要点列表输出，尽量完整，不要评论。' },
      { role: 'user', content: parts[i] },
    ], { temperature: 0.2 });
    notes.push(r);
  }
  onProgress && onProgress(0.95, '正在生成最终总结');
  return summarize(`以下是从一份长内容各部分提取的要点笔记，请据此生成完整总结：\n\n${notes.join('\n\n')}`, { onDelta });
}

/* ---------- 翻译 ---------- */
export async function translateText(text, { onProgress } = {}) {
  const CHUNK = 2800;
  const parts = [];
  let rest = text;
  while (rest.length) {
    let cut = Math.min(CHUNK, rest.length);
    if (cut < rest.length) {
      const brk = rest.lastIndexOf('\n', CHUNK);
      if (brk > CHUNK * 0.5) cut = brk + 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  const outs = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress && onProgress(i / parts.length, `翻译中 ${i + 1}/${parts.length}`);
    const r = await chat([
      { role: 'system', content: '你是专业翻译。把用户内容翻译成自然流畅的简体中文，保留 Markdown 格式与人名/专有名词，只输出译文。源语言可能是英语、印尼语（Bahasa Indonesia）或其他任何语言；若内容本身就是中文，原样输出。' },
      { role: 'user', content: parts[i] },
    ], { temperature: 0.2 });
    outs.push(r.trim());
  }
  onProgress && onProgress(1, '翻译完成');
  return outs.join('\n\n');
}

/* 逐字稿分段翻译：保持与原段落对齐 */
export async function translateSegments(segments, { onProgress } = {}) {
  const B = 24;
  const out = new Array(segments.length);
  for (let start = 0; start < segments.length; start += B) {
    const idx = segments.map((_, i) => i).slice(start, start + B);
    const joined = idx.map(i => `${i + 1}. ${segments[i].t}`).join('\n');
    onProgress && onProgress(start / segments.length, `翻译中 ${Math.min(start + B, segments.length)}/${segments.length}`);
    let r = '';
    try {
      r = await chat([
        { role: 'system', content: '你是专业翻译。输入是带编号的逐字稿段落（源语言可能是英语、印尼语或其他任何语言），请逐段翻译成简体中文，按相同格式输出（编号. 译文），不合并、不遗漏、不加解释。若已是中文则原样输出。' },
        { role: 'user', content: joined },
      ], { temperature: 0.2 });
    } catch (e) { r = ''; }
    const map = {};
    for (const line of r.split('\n')) {
      const m = /^\s*(\d+)\s*[.、):：]\s*(.+)$/.exec(line);
      if (m) map[+m[1]] = m[2].trim();
    }
    for (const i of idx) out[i] = map[i + 1] || segments[i].t;
  }
  onProgress && onProgress(1, '翻译完成');
  return out;
}

/* ---------- 笔记 AI 整理 ---------- */
export async function polishNote(text) {
  return chat([
    { role: 'system', content: '你是写作助手。把用户的笔记整理成结构清晰、语句通顺的 Markdown（保留原意与全部要点，可加小标题与列表），只输出整理后的内容。' },
    { role: 'user', content: text },
  ], { temperature: 0.4 });
}

/* ---------- AI 对话 ---------- */
export async function chatWith(history, context, userMsg, { onDelta } = {}) {
  const messages = [
    { role: 'system', content: `你是用户资料库的 AI 助手，基于以下参考资料回答问题。用简体中文，简洁准确。若资料无关，请直说。\n\n【参考资料】\n${context.slice(0, 14000)}` },
    ...history,
    { role: 'user', content: userMsg },
  ];
  return chat(messages, { stream: true, onDelta, temperature: 0.5 });
}
