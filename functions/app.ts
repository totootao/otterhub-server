import { corsMiddleware } from "./middleware/cors";
import { authRoutes } from "./routes/auth";
import { settingsRoutes } from "./routes/settings";
import { fileRoutes } from "./routes/file";
import { healthRoutes } from "./routes/health";
import { wallpaperRoutes } from "./routes/wallpaper";
import { uploadRoutes } from "./routes/upload";
import { trashRoutes } from "./routes/trash";
import { proxyRoutes } from "./routes/proxy";
import { shareRoutes } from "./routes/share";
import { telegramWebhookRoutes } from "./routes/telegram/webhook";
import { webdavRoutes } from "./routes/webdav";
import { Hono } from "hono";
import type { Env } from "./types/hono";
import { resolveRemoteKV } from "./utils/remote-kv";
import { configureTgProxy } from "./utils/tg-proxy";

export const app = new Hono<{
  Bindings: Env;
}>().basePath("");

// Global Middleware

// Telegram 代理注入：配置 TG_API_BASE 后所有 TG API 请求改走自建代理
// （必须在所有路由之前执行，详见 utils/tg-proxy.ts）
app.use("*", async (c, next) => {
  configureTgProxy(c.env);
  await next();
});

// 远程 KV 注入：配置 KV_ENDPOINT + KV_AUTH_TOKEN 后，将 oh_file_url 整体替换为自托管 KV，
// 绕过 Cloudflare KV 每日写入配额限制（必须在所有路由之前执行）
app.use("*", async (c, next) => {
  const remote = resolveRemoteKV(c.env);
  if (remote) {
    (c.env as any).oh_file_url = remote;
  }
  await next();
});

app.use("*", corsMiddleware);

// Routes
app.route("/file", fileRoutes);

app.route("/auth", authRoutes);
app.route("/settings", settingsRoutes);
app.route("/health", healthRoutes);
app.route("/wallpaper", wallpaperRoutes);
app.route("/upload", uploadRoutes);
app.route("/trash", trashRoutes);
app.route("/proxy", proxyRoutes);
app.route("/share", shareRoutes);
app.route("/telegram", telegramWebhookRoutes);
app.route("/dav", webdavRoutes);

// Export AppType for RPC
export type AppType = typeof app;
