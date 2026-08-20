#!/bin/sh
# ============================================================
# OtterHub Docker 启动脚本
#
# 职责：
#   1. 将运行时环境变量写入 .dev.vars（wrangler pages dev 原生读取，
#      可承载含逗号/引号/JSON 的复杂值，如 TG_BOT_POOLS）
#   2. 以本地 KV/R2 模拟方式启动完整应用（前端静态资源 + Functions）
#
# 可配置环境变量（与 .env.example 一致）：
#   必填（有默认兜底，生产务必覆盖）:
#     PASSWORD          管理密码：网页登录 + WebDAV Basic 认证
#     API_TOKEN         API 令牌：Bearer 认证（WebDAV / 管理接口）
#   Telegram 存储（未配置时使用本地模拟 R2 存储，仅适合体验）:
#     TG_BOT_TOKEN      Telegram Bot Token
#     TG_CHAT_ID        Telegram Chat ID
#     TG_BOT_POOLS      多 Bot/多频道池（可选，防流控）
#     TG_WEBHOOK_SECRET 频道发文件自动入库的 Webhook 密钥（可选）
#   自托管 KV（可选，绕过 Cloudflare KV 写配额）:
#     KV_ENDPOINT / KV_AUTH_TOKEN / KV_BASE_PATH
#   其他:
#     JWT_SECRET        JWT 签名密钥（可选，未配置回落用 PASSWORD）
#     PORT              监听端口（默认 8788）
# ============================================================
set -e

: "${PORT:=8788}"
# 与项目本地开发默认值保持一致，未设置凭据时兜底（生产环境务必显式配置）
: "${PASSWORD:=123456}"
: "${API_TOKEN:=123456}"

VARS_FILE=/app/.dev.vars
: > "$VARS_FILE"

write_var() {
  name="$1"; value="$2"
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$name" "$value" >> "$VARS_FILE"
  fi
}

write_var PASSWORD          "$PASSWORD"
write_var API_TOKEN         "$API_TOKEN"
write_var JWT_SECRET        "$JWT_SECRET"
write_var TG_BOT_TOKEN      "$TG_BOT_TOKEN"
write_var TG_CHAT_ID        "$TG_CHAT_ID"
write_var TG_BOT_POOLS      "$TG_BOT_POOLS"
write_var TG_WEBHOOK_SECRET "$TG_WEBHOOK_SECRET"
write_var TG_API_BASE      "$TG_API_BASE"
write_var TG_PROXY_TOKEN   "$TG_PROXY_TOKEN"
write_var KV_ENDPOINT       "$KV_ENDPOINT"
write_var KV_AUTH_TOKEN     "$KV_AUTH_TOKEN"
write_var KV_BASE_PATH      "$KV_BASE_PATH"

echo "[entrypoint] 已注入变量: $(cut -d= -f1 "$VARS_FILE" | paste -sd, -)"

# 支持挂载自定义 CA（内网自签证书等）：
#   -v ./my-ca.crt:/usr/local/share/ca-certificates/my-ca.crt:ro
# 挂载后每次启动自动重建系统信任库
if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then
  echo "[entrypoint] 检测到自定义 CA，更新系统信任库"
  update-ca-certificates >/dev/null 2>&1 || true
fi

# ---------- 远程 KV 连通性自检 ----------
# 用系统 CA 库（--use-openssl-ca）验证 TLS，与 workerd 出站校验行为一致；
# 失败仅告警不阻断启动，并给出针对性修复提示。
if [ -n "$KV_ENDPOINT" ]; then
  KV_ENDPOINT="$KV_ENDPOINT" KV_AUTH_TOKEN="$KV_AUTH_TOKEN" \
    node --use-openssl-ca /app/kv-precheck.mjs || true
fi

echo "[entrypoint] 启动 wrangler pages dev (0.0.0.0:${PORT})，数据目录 /app/data"

exec npx wrangler pages dev frontend/out \
  --kv oh_file_url \
  --r2 oh_file_r2 \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to /app/data
