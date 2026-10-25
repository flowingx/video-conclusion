FROM node:20-slim

# ffmpeg 转码；python3+pip 安装 yt-dlp（比 PyInstaller 独立二进制在容器里更稳，无 PYI 运行时怪癖）
RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
       ffmpeg ca-certificates curl python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js bailian-asr.js ./
COPY public ./public

# Render Free 分配的端口通过环境变量注入
ENV HOST=0.0.0.0
EXPOSE 10000

CMD ["node", "server.js"]
