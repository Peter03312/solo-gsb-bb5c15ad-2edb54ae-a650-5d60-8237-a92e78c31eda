FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 有预编译二进制；无预编译时用 build-deps 现场编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

# 初始化数据（建表 + 示例数据）并在前台启动
CMD ["sh", "-c", "node src/seed.js && node server.js"]
EXPOSE 3000
VOLUME ["/data"]
