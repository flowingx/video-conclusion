# Leanin 本地版 — 视频音频解析 / 逐字稿 / AI 总结

复刻 [Leanin](https://leanin.flowin.cn)（2026-08-31 停服）的本地自托管版本：粘贴视频/图文链接或上传音视频文件，自动提取内容 → 外语翻译成中文 → 生成逐字稿和结构化 AI 总结。**所有数据只存在本机。**

![技术栈](https://img.shields.io/badge/Node-24%2B-green) ![依赖](https://img.shields.io/badge/后端依赖-零-orange) ![License](https://img.shields.io/badge/license-MIT-blue)

## 快速开始

```bash
# 1. 确保已安装 Node.js 18+（本机已验证 v24）
# 2. 双击 start.bat，或：
node server.js
# 3. 浏览器打开
#    http://127.0.0.1:5218
```

首次使用请到页面左下角 **设置**：

| 配置项 | 说明 |
|---|---|
| **AI API Key**（必填，用于翻译+总结） | 任意 OpenAI 兼容接口。推荐[智谱](https://open.bigmodel.cn) `glm-4-flash`（免费）；DeepSeek / OpenAI / OpenRouter 均可。填完点「测试连接」 |
| **转写模型** | `base`（推荐，约 80MB，首次转写时自动下载）；追求中文准确率选 `small` |
| **音频语言** | 中文内容建议选「中文」（自动检测偶尔会误判） |
| **浏览器 Cookie** | 解析需登录内容（小红书/Instagram 等）时选 Chrome（解析时需关闭 Chrome） |
| **网络代理** | 解析 YouTube / Instagram / X 等海外平台时填 `http://127.0.0.1:7890`；国内平台留空 |

## 功能

- **解析链接**：B站 / 抖音 / 小红书 / YouTube / X / Instagram / TikTok / 微博 / 微信公众号 / 知乎 / 播客等（基于 yt-dlp，支持其全部站点）
- **上传音视频**：mp3 / m4a / wav / mp4 / webm 等，浏览器本地转写
- **实时录音**：现场记录，边录边转写
- **新建笔记**：随手记，AI 一键整理
- **智能处理链**：平台字幕优先（秒出逐字稿）→ 无字幕时 Whisper 语音转写（WebGPU 加速）→ **声纹识别说话人**（pyannote，自动区分不同的人，可点击改名）→ 外语自动翻译成中文 → 结构化 AI 总结（标题/基本信息/核心内容/详细内容/关键洞察，与 Leanin 同款格式）
- **逐字稿按说话人分组展示**：同一人连续发言合并为一组，只显示一次头像和名字，多人对话用不同颜色区分
- **AI 对话**：详情页右侧 ✦ 按钮，基于笔记内容问答
- **数据备份**：左下角导出/导入 JSON；单篇可导出 Markdown

## 目录结构

```
server.js          零依赖 Node 后端（静态页 + yt-dlp 解析/下载 + 正文抓取 + LLM 转发）
public/            前端（原生 ES Module，无构建步骤）
bin/               yt-dlp.exe / ffmpeg.exe
data/              运行时数据（音频缓存 48h 自动清理、服务配置）
start.bat          Windows 一键启动
```

## 常见问题

- **转写模型下载失败**：网络无法直连 HuggingFace 时会自动切换 hf-mirror.com 镜像；也可在设置里手动勾选镜像。
- **解析国内平台失败**：多半是平台风控，重试一次；或设置里开启浏览器 Cookie 后再试（需先完全退出 Chrome）。小红书/抖音图文帖会自动回退到正文抓取。
- **解析海外平台失败**：设置里填代理（如 Clash 的 `http://127.0.0.1:7890`）。
- **长视频很慢**：转写在浏览器进行，base 模型 CPU 约 4 倍速（55 分钟视频约 14 分钟）；有 WebGPU 显卡会快数倍。有平台字幕的视频（YouTube/B站 CC）则秒级完成。
- **API Key 安全**：Key 只保存在浏览器 localStorage，LLM 请求经本地服务转发到官方接口，不经过任何第三方。

## 为什么选择自建而不是现成开源项目

调研过 AI-Video-Transcriber（3.2k★）、OmniVault、XHS-Downloader 等项目后，差异如下：

| 需求 | AI-Video-Transcriber | 本项目 |
|---|---|---|
| Leanin 风格界面与交互 | ❌ 自带另一套 UI | ✅ 完整复刻 |
| 图文/文章链接（公众号、知乎等） | ❌ | ✅ |
| 抖音 / 小红书 | ⚠️ 未内置（yt-dlp 现已支持，需自己验证） | ✅ 直接可用 |
| 外语自动翻译中文 | ✅ | ✅ |
| 部署依赖 | Python + FFmpeg + Docker(1.6GB) | 仅 Node，零 npm 依赖 |
| 转写 | 服务端 faster-whisper | 浏览器 Whisper（免装环境，借它的"字幕优先"思路已吸收） |

OmniVault（0★，需关注作者领激活码）与 MediaCrawler（批量爬取场景）不符合单链接解析需求，未采用。
