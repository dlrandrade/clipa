FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip fonts-inter ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp opencv-python-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

CMD ["node", "src/index.js"]
