FROM node:20-slim

# ffmpeg 供音频转码，ca-certificates 供 HTTPS，curl 供下载 yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp 官方 Linux 二进制（不进 git 仓库，构建时拉最新版）
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public

# Render Free 分配的端口通过环境变量注入
ENV HOST=0.0.0.0
EXPOSE 10000

CMD ["node", "server.js"]
