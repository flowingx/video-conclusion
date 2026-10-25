# 项目索引 — Leanin 本地版（视频/音频解析 · 逐字稿 · AI 总结）

> 自托管复刻版 Leanin：粘贴链接或上传音视频 → 提取内容 → 翻译中文 → 声纹识人 → 结构化 AI 总结。
> 技术栈：零依赖 Node 后端 + 原生 ES Module 前端（无构建步骤）。
> 端口：HTTP `127.0.0.1:5218` / HTTPS `127.0.0.1:5219`（供 GitHub Pages 前端跨混合内容限制调用）。

---

## 一、文件总览

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.js` | 533 | 零依赖 Node 后端：静态页 + API 全部逻辑 |
| `public/index.html` | 56 | 单页应用骨架（侧边栏 + 主区 + 弹窗/抽屉/Toast 挂载点） |
| `public/js/app.js` | 1295 | 主应用：路由、工作台、解析流水线、详情页、录音、设置、AI 对话 |
| `public/js/transcribe.js` | 86 | 转写门面：音频解码 + Worker 任务派发 |
| `public/js/asr-worker.js` | 228 | Web Worker：Whisper 转写 + pyannote 声纹识别推理 |
| `public/js/llm.js` | 184 | LLM 客户端：总结/翻译/笔记整理/对话（经本地服务转发） |
| `public/js/db.js` | 104 | 数据层：IndexedDB 笔记 + localStorage 设置 + 导入导出 |
| `public/js/util.js` | 193 | 工具：图标库、平台识别、时间格式化、语言检测、轻量 Markdown 渲染 |
| `public/css/style.css` | 339 | 全部样式（Leanin 复刻 UI） |
| `deploy.sh` | 27 | 把 public/ 强推到 gh-pages 分支部署 GitHub Pages |
| `start.bat` | 15 | Windows 一键启动（把 Git 的 openssl 加入 PATH 以生成证书） |
| `bin/` | — | yt-dlp.exe / ffmpeg.exe（不进仓库） |
| `data/` | — | 运行时数据：config.json（Key/令牌/代理）、media/（音频缓存 48h）、backups/（滚动 10 份）、cert.pem/key.pem |

---

## 二、后端 server.js 功能索引（按行号）

| 行号 | 功能块 | 说明 |
|---|---|---|
| 15-27 | 常量与路径 | ROOT/PUB/DATA/MEDIA、端口 5218/5219、YT_DLP/FFMPEG 路径（云端容器回退系统 ffmpeg） |
| 29-38 | MIME 表 | 静态文件与音频格式的 Content-Type 映射 |
| 43-57 | **配置管理** | `data/config.json` 读写；云端用环境变量 LLM_KEY/ACCESS_TOKEN 注入；`publicConfig()` 只暴露布尔状态，绝不回传 Key/令牌；`safeEq()` 常量时间比较防时序攻击 |
| 63-66 | **CSRF/Origin 白名单** | `ORIGIN_OK()`：github.io / localhost / onrender.com / ALLOWED_ORIGIN 环境变量，其余 403 |
| 69-82 | HTTP 工具 | `sendJSON`、`readBody`（64MB 上限）、伪装 UA |
| 84-100 | **yt-dlp 执行器** | `runYtDlp()`：spawn + stdout 逐行回调（进度）+ 超时保护 + 输出封顶 100MB |
| 102-129 | **Cookie 锁自动降级** | Windows 下 Chrome/Edge 运行时锁定 Cookie 数据库 → 命中特征错误后去掉 `--cookies-from-browser` 重跑；`friendlyCookieError()` 给中文提示 |
| 131-140 | 启动清理 | 删除 media/ 中超过 48 小时的音频缓存 |
| 143-158 | **静态文件服务** | 路径穿越防护 + SPA 兜底（404 回 index.html） |
| 160-183 | **媒体文件服务** | `serveMedia()`：文件名白名单校验、HTTP Range 分段（206）支持拖动播放 |
| 186-218 | **链接解析 API** | `apiResolve()`：`yt-dlp -J` 取元数据（标题/作者/时长/封面/简介），筛选最优纯音频流 |
| 221-270 | **平台字幕 API** | `parseSubtitles()`：VTT/SRT/TTML 正则解析、YouTube 自动字幕滚动去重；`apiSubs()`：下载字幕文件按语言打分（中>英>其他）选最优 |
| 273-302 | **音频下载任务** | `apiDownload()`：异步任务表 `jobs`(Map)，有 ffmpeg 时转 m4a，逐行解析 `[download] xx%` 进度 |
| 305-374 | **文章抓取 API** | `apiArticle()`：fetch 网页 → meta/og 标签取标题封面 → 按优先级提正文（微信公众号 js_content → 知乎 → `<article>` → body 兜底）→ `htmlToText()` 转 Markdown 风格纯文本 |
| 377-417 | **LLM 转发 API** | `apiLlm()`：令牌门禁 → 服务端注入 Key → 转发任意 OpenAI 兼容接口，SSE 流式透传（10 分钟超时） |
| 420-432 | **备份 API** | `apiBackup()`：POST 校验格式后写入 data/backups/，滚动保留 10 份 |
| 435-490 | **路由总入口** | `handler()`：Origin 校验 → CORS 头 → 令牌门禁（豁免 /api/health 与 /api/media/*）→ 分发 13 个端点 |
| 493-512 | **自签名证书** | `ensureCert()`：调用 openssl（含 Git 自带路径）生成 CN=127.0.0.1 的 10 年证书 |
| 514-532 | 启动 | HTTP + HTTPS 双端口监听、启动横幅（工具链检查） |

### API 端点速查

| 方法 | 路径 | 功能 | 令牌 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 + yt-dlp/ffmpeg 版本 + 配置状态 | 免 |
| GET/POST | `/api/config` | 读/写配置（写敏感项需带令牌） | 读免 |
| POST | `/api/resolve` | yt-dlp 解析链接元数据 | 需 |
| POST | `/api/subs` | 下载并解析平台字幕 → 分段 | 需 |
| POST | `/api/download` | 创建音频下载任务 → id | 需 |
| GET | `/api/job/:id` | 轮询下载任务进度 | 需 |
| POST | `/api/article` | 抓取图文/文章正文 | 需 |
| POST | `/api/llm` | LLM 请求转发（流式） | 需 |
| POST/GET | `/api/backup` | 上传/列出笔记备份 | 需 |
| GET | `/api/media/:file` | 音频文件（Range 支持） | 免 |
| GET | 其他 | 静态文件（SPA 兜底） | — |

---

## 三、前端模块索引

### 1. `public/index.html` — 页面骨架
- 顶部横幅 `#banner`（GitHub Pages 模式连接状态提示）
- 左侧栏：工作台 / 标签 导航 + 实时录音 / 导出数据 / 导入数据 / 设置 按钮
- 挂载点：`#main`（路由主区）、`#modal-root`、`#drawer-root`（AI 对话抽屉）、`#toast-root`、`#player`

### 2. `public/js/app.js` — 主应用（按行号）

| 行号 | 功能块 | 说明 |
|---|---|---|
| 7-14 | 全局状态 | 设置 S、笔记列表、批量选择、`runningPipelines`（防重入）、AI 对话历史 |
| 17-28 | API 封装 | `api()` POST + 令码头；`mediaUrl()` 拼音频地址 |
| 35-56 | 步骤面板 | `setSteps/stepSet/renderSteps`：流水线进度条渲染 |
| 59-71 | **hash 路由** | `#/workbench` `#/tags/:t` `#/record` `#/settings` `#/resource/:id` |
| 74-146 | **工作台** | 4 个快捷入口卡片、资料列表卡片、批量管理（全选/删除/导出 Markdown） |
| 149-169 | 标签页 | 标签云 + 按标签筛选列表 |
| 172-252 | 弹窗 | 解析链接 / 上传音视频（拖拽）/ 新建笔记 |
| 255-292 | **链接流水线调度** | `runLinkPipeline()`：按 URL 判断文章 vs 视频；视频失败自动回退图文抓取 |
| 295-383 | **视频流水线** | `runVideoPipeline()`：解析 → 平台字幕 → 下载音频 → Whisper 转写 → 声纹 → AI；双源字幕并列保存；旧笔记懒迁移 |
| 386-425 | **声纹识别** | `runDiarize()`：>45 分钟跳过；调 worker 标注说话人；结果写回 transcript |
| 428-441 | LLM 输入构造 | `transcriptText()`（多说话人加标签）；`aiInputText()`（双源并列喂给 LLM 综合参考） |
| 444-452 | 逐字稿渲染数据 | `speakerRuns()`：连续同一说话人合并为气泡组 |
| 454-480 | 网络工具 | `pollJob()` 轮询下载；`fetchWithProgress()` 流式下载带进度 |
| 483-502 | **文章流水线** | `runArticlePipeline()`：抓正文 → AI |
| 505-532 | **文件流水线** | `runFilePipeline()`：本地文件 → 转写 → 声纹 → AI |
| 535-595 | **AI 步骤** | `runAiSteps()`：语言检测 → 按翻译规则翻译（分段/整文）→ 流式总结（长文分块 map-reduce） |
| 599-676 | **详情页** | 顶栏（对话/导出/删除）、来源卡、音频播放器、三个 Tab（转写/翻译/总结）、处理中断自动恢复 |
| 690-809 | 转写 Tab | 笔记编辑器 + AI 整理；逐字稿按说话人分组渲染；**双源对照视图**（平台字幕 vs Whisper 并排）；时间戳点击跳播；说话人点击改名 |
| 811-837 | 翻译/总结 Tab | 逐段对照翻译展示；总结复制/重新生成 |
| 839-876 | 提示框 | 错误重试（重试 AI / 重新解析）、未配 Key 提示、一键生成 CTA |
| 883-893 | **导出 Markdown** | 标题 + 来源 + 总结 + 翻译 + 逐字稿 组装下载 |
| 896-939 | **AI 对话抽屉** | 基于笔记内容问答，保留最近 12 条历史，流式渲染 |
| 942-1061 | **实时录音** | `startRec/stopRec`：16kHz 采集，每 ~14s 增量转写实时上屏，结束后存笔记 + 声纹 + AI 总结 |
| 1064-1233 | **设置页** | AI 服务（Key 保存到服务端/令牌写入/测试连接）、转写（模型/语言/镜像/声纹/双源）、备份、本地服务（地址/Cookie/代理） |
| 1236-1295 | 侧边栏与全局 | 导入导出数据、横幅、自动备份（变更停止 15s 后触发）、HTTPS 模式连通性检测 |

### 3. `public/js/transcribe.js` — 转写门面（主线程）
- `MODELS`：tiny/base/small 三个 onnx-community Whisper 模型
- `decodeAudio()`：任意音视频 Blob → 16kHz 单声道 Float32（多声道取平均）
- `transcribe()` / `diarize()`：向 Worker 派发任务，回调转译进度消息
- `workerTask()`：jobId 匹配 + Promise 化的消息协议

### 4. `public/js/asr-worker.js` — 推理 Worker（独立线程）
- `buildAsr()`：加载 Whisper，优先 WebGPU（fp32 encoder + q4 decoder），失败降级 WASM q8；HF 直连失败自动换 hf-mirror
- `runAsr()`：30s 分块 + 5s 重叠滑窗转写，`mergeSegments()` 合并碎段
- `diarizeTask()`：**纯浏览器 pyannote 声纹识别** — pyannote-segmentation-3.0 模型，10s 窗口 8s 步进推理，powerset 解码为 3 个本地说话人激活概率，重叠区贪心匹配对齐全局轨迹，过滤幽灵说话人后按激活积分给每段分配说话人

### 5. `public/js/llm.js` — LLM 客户端
- `chat()`：统一请求入口，经 `/api/llm` 转发（规避 CORS），支持 SSE 流式解析
- `summarize()`：Leanin 同款结构化总结 Prompt（标题/基本信息/核心内容/详细内容/关键洞察 + TAGS 尾行解析）
- `summarizeLong()`：>16k 字分块要点提取（map）再合并总结（reduce）
- `translateText()` / `translateSegments()`：整文/逐段对齐翻译（24 段一批，编号映射回原位置）
- `polishNote()`：随手笔记 AI 整理
- `chatWith()`：基于笔记上下文的对话（上下文截断 14k）

### 6. `public/js/db.js` — 数据层
- IndexedDB `leanin-local/notes`：`all/get/put/patch/del`，每次写入派发 `leanin-notes-changed` 事件（自动备份订阅）
- 设置存 localStorage `leanin_settings`：默认值含 serverUrl 智能判断（本机 origin vs https 静态托管 → 5219）
- `exportAll/importAll`：JSON 全量导出/导入

### 7. `public/js/util.js` — 工具集
- `esc()`、`$/$$`、`icon()`（内置 16 个 SVG 图标）
- `platformOf()/platformMeta()`：11 个平台域名正则识别 + 品牌配色
- `fmtDur/fmtClock/fmtDate`、`stripMd()`
- `detectLang()`：zh/ja/ko 按文字系统，拉丁语按功能词频率区分英语/印尼语（stopword 集合）
- `toast()/download()`、`renderMd()`：轻量 Markdown 渲染器（标题/列表/表格/代码块/引用/链接）

---

## 四、端到端功能链路

```
【视频链接】runLinkPipeline → runVideoPipeline
  /api/resolve(元数据) → /api/subs(平台字幕,秒出) → /api/download(音频)
  → fetch 音频 → Whisper Worker 转写 → pyannote 声纹 → AI 翻译 → AI 总结(流式)

【图文链接】runLinkPipeline → runArticlePipeline
  /api/article(正文抓取) → AI 翻译(整文) → AI 总结

【本地上传】uploadModal → runFilePipeline
  decodeAudio → Whisper → 声纹 → AI

【实时录音】renderRecord → startRec/stopRec
  每14s增量转写 → 存笔记 → 声纹 → AI

【随手笔记】noteModal → 保存 → 详情页「AI 整理」polishNote

【AI 对话】详情页 ✦ → chatWith(笔记上下文)
```

## 五、安全模型（四层）

1. Key 只存本地服务端 `data/config.json`（.gitignore 排除），浏览器不留明文
2. 访问令牌门禁：全 API（除 health/media）须带 `x-access-token`
3. Origin 白名单：恶意网页无法驱使本地服务
4. 接口脱敏：只返回 `hasKey/hasToken` 布尔值；修改敏感配置须先带当前令牌
