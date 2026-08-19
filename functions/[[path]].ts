import { app } from "./app";
import { handle } from "hono/cloudflare-pages";

const handler = handle(app);

export const onRequest = async (ctx: any) => {
  const res = await handler(ctx);

  // 只有 Hono 默认的“路由未命中 404”才回退给 Pages（避免Hono接管所有路径导致网站 404）
  // WebDAV (/dav) 是纯 API 命名空间，其 404/405 必须原样返回给客户端，不能被静态资源覆盖
  const isDavPath = new URL(ctx.request.url).pathname.startsWith("/dav");
  if (
    !isDavPath &&
    res.status === 404 &&
    !res.headers.get("content-type")?.includes("application/json")
  ) {
    return ctx.next();
  }

  return res;
};
