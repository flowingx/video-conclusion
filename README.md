# Leanin 本地版 — 视频音频解析 / 逐字稿 / AI 总结

复刻 [Leanin](https://leanin.flowin.cn)（2026-08-31 停服）的自托管版本：粘贴视频/图文链接或上传音视频文件，自动提取内容 → 外语翻译成中文 → 声纹识别说话人 → 生成逐字稿和结构化 AI 总结。**笔记保存在本机；语音转写会将音频发送至百炼，翻译与总结会调用所配置的 AI 服务。**

**两种使用方式**：

| 方式 | 地址 | 说明 |
|---|---|---|
| 本机使用 | `http://127.0.0.1:5218` | 运行 `start.bat` 即可，功能完整 |
| **GitHub Pages 前端** | [flowingx.github.io/video-conclusion](https://flowingx.github.io/video-conclusion/) | 界面托管在 Pages，解析由本机服务完成，语音由本机服务调用百炼转写（见下文） |

![技术栈](https://img.shields.io/badge/Node-24%2B-green) ![依赖](https://img.shields.io/badge/后端依赖-零-orange) ![License](https://img.shields.io/badge/license-MIT-blue)

## 快速开始

```bash
# 1. 确保已安装 Node.js 22+（本机已验证 v24）
# 2. 双击 start.bat，或：
node server.js
# 3. 浏览器打开
#    http://127.0.0.1:5218
```

首次使用请到页面左下角 **设置**：

| 配置项 | 说明 |
|---|---|
| **AI API Key**（必填，用于翻译+总结） | 任意 OpenAI 兼容接口。推荐[智谱](https://open.bigmodel.cn) `glm-4-flash`（免费）；DeepSeek / OpenAI / OpenRouter 均可。填完点「测试连接」 |
| **转写模型** | 百炼 `qwen3-asr-flash-filetrans`（只处理音频，无需下载模型） |
| **音频语言** | 中文内容建议选「中文」（自动检测偶尔会误判） |
| **浏览器 Cookie** | 解析需登录内容（小红书/Instagram 等）时选 Chrome（解析时需关闭 Chrome） |
| **网络代理** | 解析 YouTube / Instagram / X 等海外平台时填 `http://127.0.0.1:7890`；国内平台留空 |

## 功能

- **解析链接**：B站 / 抖音 / 小红书 / YouTube / X / Instagram / TikTok / 微博 / 微信公众号 / 知乎 / 播客等（基于 yt-dlp，支持其全部站点）
- **上传音视频**：mp3 / m4a / wav / mp4 / webm 等，浏览器提取音频后由百炼转写
- **实时录音**：现场记录，边录边转写
- **新建笔记**：随手记，AI 一键整理
- **智能处理链**：平台字幕优先（秒出逐字稿）→ 百炼音频转写（可与平台字幕并列保存）→ **声纹识别说话人**（可选本地 pyannote，默认关闭，可点击改名）→ 外语自动翻译成中文 → 结构化 AI 总结（标题/基本信息/核心内容/详细内容/关键洞察，与 Leanin 同款格式）
- **逐字稿按说话人分组展示**：同一人连续发言合并为一组，只显示一次头像和名字，多人对话用不同颜色区分
- **AI 对话**：详情页右侧 ✦ 按钮，基于笔记内容问答
- **数据备份**：左下角导出/导入 JSON；单篇可导出 Markdown

## 目录结构

```
server.js          零依赖 Node 后端（静态页 + HTTP/HTTPS + yt-dlp 解析/下载 + 正文抓取 + LLM 转发）
public/            前端（原生 ES Module，无构建步骤）——即 GitHub Pages 部署的内容
bin/               yt-dlp.exe / ffmpeg.exe（不进仓库，需自行放置）
deploy.sh          部署 public/ 到 gh-pages 分支
data/              运行时数据（音频缓存 48h 自动清理、自签名证书、服务配置）
start.bat          Windows 一键启动
```

## GitHub Pages 前端模式

前端托管在 GitHub Pages，解析/下载由本机服务完成，音频通过本机服务发送到百炼转写：

1. 本机运行 `start.bat`（HTTPS 端口 5219 会自动生成自签名证书）
2. 浏览器打开一次 `https://127.0.0.1:5219` → 点「高级 → 继续前往」信任证书（仅需一次，这是 Chrome 对 HTTPS 页面调用本地服务的要求）
3. 打开 [flowingx.github.io/video-conclusion](https://flowingx.github.io/video-conclusion/)，页面横幅会显示连接状态；首次使用在设置里填 API Key（Key 按 origin 隔离存储，与本机使用是分开的）

> 原理：HTTPS 页面不能直接请求 `http://127.0.0.1`（混合内容限制），所以本地服务额外监听 5219 的 HTTPS 端口。证书只在本机生成、只指向 127.0.0.1，不涉及任何第三方。

更新线上前端：`bash deploy.sh`（把 public/ 强推到 gh-pages 分支）。

## 部署到 Render 免费云（电脑关机也能用）

本服务已 Docker 化（`Dockerfile` + `render.yaml`），可部署到 Render 免费层，电脑关机后前端照常可用：

1. 注册/登录 [render.com](https://render.com)（可用 GitHub 账号直接登录）
2. 控制台 → **New → Web Service** → 连接 GitHub 仓库 `flowingx/video-conclusion`
3. Render 自动读取 `render.yaml`（Docker 运行时、免费套餐）。首次创建时在 Environment 填两个密钥：
   - `LLM_KEY`：你的 AI API Key
   - `ACCESS_TOKEN`：自定义一串访问令牌（**务必设置**，否则服务会被陌生人白嫖）
   - `ALLOWED_ORIGIN` 已默认指向 `https://flowingx.github.io`
4. 点 Create，等几分钟构建（自动安装 ffmpeg + yt-dlp），得到 `https://video-conclusion-xxxx.onrender.com`
5. 回到 GitHub Pages 前端 → 设置 → 服务地址改成 Render 地址 → 横幅变绿即成功

**免费层须知**：闲置 15 分钟休眠、冷启动 30~60 秒；每月 750 小时额度；**容器文件系统是临时的**（重启后 data/ 重置，密钥走环境变量不受影响）；国内直连 onrender.com 偶尔不稳，可配合代理。API Key 安全模型在云端同样生效（令牌门禁 + Origin 白名单）。更新代码：push 到 main 后自动重新部署。

## API Key 安全模型

GitHub Pages 前端是公开的，但你的 Key **不在任何公开代码里**，保护分四层：

1. **Key 只存在本地服务端**：设置页点「把 Key 保存到本地服务」后，Key 写入 `data/config.json`（`.gitignore` 已排除，永不进仓库，GitHub 扫描机器人不可能碰到），浏览器 localStorage 里的明文会被清掉
2. **访问令牌门禁（全接口）**：设置令牌后，除健康检查与音频文件外**所有 API 都必须携带令牌**——解析、下载、配置修改一样受限，别人无法白嫖你的服务器当下载代理，更用不了你的 Key；怀疑泄漏随时换新令牌
3. **CSRF / Origin 白名单**：浏览器发起的跨站请求必带 Origin，白名单（github.io / localhost）之外一律 403——你浏览任何恶意网页时，它都无法驱使你的本地服务（例如偷偷改代理配置窃取 Cookie）
4. **接口脱敏**：`/api/health`、`/api/config` 只返回 `hasKey`/`hasToken` 布尔值，永远不会回传 Key 或令牌本身；修改 Key/令牌/代理/Cookie 要求先携带当前令牌（403 保护）

典型使用：本机 `http://127.0.0.1:5218` 与 GitHub Pages 前端共用同一份服务端 Key；其他设备访问只需在它的设置里填同一个访问令牌。若部署到自己的域名/VPS，需在 `server.js` 的 `ORIGIN_OK` 白名单中加入你的域名。

## 数据存在哪（多入口说明）

笔记保存在**浏览器的 IndexedDB**，按站点隔离：`127.0.0.1:5218` 和 `flowingx.github.io` 是两个独立的数据空间，互相看不到。建议**固定使用一个入口**（推荐 github.io）；开启「自动备份」后每次变更会滚动备份到本地服务 `data/backups/`（保留 10 份），换浏览器/清缓存前可用「导出数据」或直接取备份文件恢复。

## 常见问题

- **语音转写失败**：检查服务端密钥、对应的北京业务空间地址、模型权限及免费额度；本地声纹模型下载失败时可在设置中启用镜像。
- **解析国内平台失败**：多半是平台风控，重试一次；或设置里开启浏览器 Cookie 后再试（需先完全退出 Chrome）。小红书/抖音图文帖会自动回退到正文抓取。
- **解析海外平台失败**：设置里填代理（如 Clash 的 `http://127.0.0.1:7890`）。
- **长视频很慢**：耗时取决于音频解码、上传速度及百炼任务队列；可关闭“即使拿到平台字幕也使用百炼转写音频”，在有字幕时节省时间与额度。
- **API Key 安全**：百炼语音密钥只由服务端读取，不回传前端；翻译/总结密钥沿用独立配置，可保存到本地服务端。

## 为什么选择自建而不是现成开源项目

调研过 AI-Video-Transcriber（3.2k★）、OmniVault、XHS-Downloader 等项目后，差异如下：

| 需求 | AI-Video-Transcriber | 本项目 |
|---|---|---|
| Leanin 风格界面与交互 | ❌ 自带另一套 UI | ✅ 完整复刻 |
| 图文/文章链接（公众号、知乎等） | ❌ | ✅ |
| 抖音 / 小红书 | ⚠️ 未内置（yt-dlp 现已支持，需自己验证） | ✅ 直接可用 |
| 外语自动翻译中文 | ✅ | ✅ |
| 部署依赖 | Python + FFmpeg + Docker(1.6GB) | 仅 Node，零 npm 依赖 |
| 转写 | 服务端 faster-whisper | 百炼音频转写（无需本地模型，保留字幕优先流程） |

OmniVault（0★，需关注作者领激活码）与 MediaCrawler（批量爬取场景）不符合单链接解析需求，未采用。

## 百炼音频转写

语音转写改为北京地域的 `qwen3-asr-flash-filetrans`，不再下载 Whisper 模型。网页仅提取并上传 16kHz 单声道音频，视频画面不上传。时间戳、平台字幕与总结流程保留，旧笔记兼容。

启动前设置环境变量 `DASHSCOPE_API_KEY`，或在服务端 `data/bailian-key.txt` 保存密钥。密钥不会返回浏览器，也不用于翻译/总结接口。`data/`、密钥 CSV、环境配置文件已被 Git 忽略；不要将这些文件发送给他人。当前 CSV 的业务空间地址已保存到服务端 `data/bailian.json`。也可通过 `DASHSCOPE_BASE_URL` 配置北京地域官方接口地址。需要 Node.js 22 或更新版本，无额外依赖。

在百炼北京地域开通模型权限，并确认免费额度尚未过期或耗尽；新人额度为 10 小时、有效期 90 天。必须在百炼控制台开启该模型的“免费额度用完即停”，以避免自动转按量计费。程序无法代替账户设置保证免费。音频通过百炼临时存储处理，临时文件 48 小时后由平台清理。单次上传限 512MB PCM16（约 4.6 小时），更长音频请先分段。

“本地声纹识别说话人”是独立可选功能，仍需下载 pyannote；新设置及从旧版首次迁移时默认关闭，可在设置中主动启用。

验证：`node --test tests/bailian-asr.test.js`。

官方文档：[语音转写](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)、[免费额度](https://help.aliyun.com/zh/model-studio/new-free-quota/)。
