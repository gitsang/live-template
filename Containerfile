# ---------- 构建阶段 ----------
FROM node:22-alpine AS build

WORKDIR /app

# 先装依赖，利用层缓存：源码变动不必重装
COPY package.json package-lock.json ./
RUN npm ci

# 构建 SvelteKit 产物 + 弹幕服务端产物
COPY . .
RUN npm run build

# 剔除 devDependencies，只保留运行时依赖（ws）
RUN npm prune --omit=dev


# ---------- 运行阶段 ----------
FROM node:22-alpine

# tini 负责转发信号，让 Ctrl+C / docker stop 能触发优雅落盘。
# tzdata 让 shell 与 Node 的时区认知一致：Node 自带 ICU 时区数据、
# 而 alpine 默认没有 /usr/share/zoneinfo，缺了会让 `date` 显示 UTC，
# 排查 JSONL 按天分文件的问题时极易误判。
RUN apk add --no-cache tini tzdata

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    # JSONL 按天分文件依赖本地时区，必须固定，否则跨零点会算错日期
    TZ=Asia/Shanghai \
    DATA_DIR=/app/data

# 只拷贝运行所需内容
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config.json ./config.json

# 弹幕落盘目录（compose 里挂载卷）
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
