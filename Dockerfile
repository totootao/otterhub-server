# syntax=docker/dockerfile:1

# ============================================================
# OtterHub Docker 镜像
# 运行方式：wrangler pages dev 本地承载 前端静态资源 + Pages Functions
#          （KV/R2 由 workerd 本地模拟，数据持久化到 /app/data）
# 注意：wrangler 内嵌 workerd 仅支持 glibc，因此基于 debian-slim
# ============================================================

# ---------- 构建阶段：编译 Next.js 静态导出 ----------
# node 22：满足 wrangler@4 / miniflare 的 engines 要求 (node >= 22)
FROM node:22-slim AS builder
WORKDIR /app

# 先复制依赖清单（含各 workspace 的 package.json，npm ci 才能解析 workspaces），
# 充分利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/
RUN npm ci --no-audit --no-fund

# 复制源码并构建前端（输出 frontend/out）
COPY . .
ARG NEXT_PUBLIC_BACKEND_URL=""
ENV NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL}
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# 复制运行时必需产物（node_modules 含 wrangler/workerd 及 Functions 依赖）
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/functions ./functions
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/wrangler.jsonc ./
COPY --from=builder /app/frontend/out ./frontend/out
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data

# 默认端口（可通过 -e PORT 覆盖）
ENV PORT=8788
EXPOSE 8788

# 本地模拟 KV/R2 的数据持久化目录（建议挂载卷）
VOLUME ["/app/data"]

# 健康检查：/health 端点（slim 镜像无 curl/wget，用 node 内置 fetch）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
