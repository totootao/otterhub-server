import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { Env } from "../types/hono";

const corsHandler = cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowHeaders: ["Content-Type", "Authorization", "Range"],
  exposeHeaders: ["Content-Length", "Content-Range"],
  maxAge: 86400,
  credentials: true,
});

export const corsMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    // WebDAV 能力发现：客户端（Windows/macOS/RaiDrive 等）会对 /dav 发送无 Origin 的
    // OPTIONS 探测，必须由 /dav 路由返回 DAV / Allow 头，不能被 CORS 中间件短路成 204。
    // 带有 Access-Control-Request-Method 的真实浏览器预检仍交给 CORS 处理。
    if (
      c.req.method === "OPTIONS" &&
      c.req.path.startsWith("/dav") &&
      !c.req.header("Access-Control-Request-Method")
    ) {
      await next();
      return;
    }

    return corsHandler(c, next);
  }
);
