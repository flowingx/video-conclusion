FROM node:20-slim

# ffmpeg 供音频转码，ca-certificates 供 HTTPS，curl 供下载 yt-dlp
# Acquire::Retries：Debian 源偶发网络抖动时自动重试（Render 构建机网络不稳的常见坑）
RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp 独立二进制（自带 Python 运行时，node 镜像无需装 python3）
RUN curl -fSL --retry 3 --retry-delay 2 --connect-timeout 20 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY package.json ./
COPY server.js bailian-asr.js ./
COPY public ./public

# Render Free 分配的端口通过环境变量注入
ENV HOST=0.0.0.0
EXPOSE 10000

CMD ["node", "server.js"]
