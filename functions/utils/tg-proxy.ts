/**
 * Telegram API 代理支持（自部署场景）
 *
 * 配置 TG_API_BASE 后，所有对 api.telegram.org 的请求改走自建代理，
 * 例如 Cloudflare Pages 上的 otterhub-tg-proxy：https://cf.totootao.top/tg
 * 用于国内服务器等无法直连 Telegram API 的部署环境。
 *
 * TG_PROXY_TOKEN 为代理鉴权令牌（可选），以 x-proxy-token 请求头发送，
 * 与代理端 TG_PROXY_TOKEN 环境变量保持一致。
 *
 * 两个变量均未配置时行为与原版完全一致（直连 api.telegram.org）。
 */

let proxyBase: string | null = null;
let proxyToken: string | null = null;

/** 每个请求开始时由全局中间件调用，注入当前环境配置 */
export function configureTgProxy(env: {
  TG_API_BASE?: string;
  TG_PROXY_TOKEN?: string;
}): void {
  const base = env.TG_API_BASE?.trim().replace(/\/+$/, "");
  proxyBase = base ? base : null;
  proxyToken = env.TG_PROXY_TOKEN?.trim() || null;
}

/** 包装 fetch：改写 api.telegram.org 基址并附加代理鉴权头 */
export function tgFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = proxyBase
    ? url.replace(/^https:\/\/api\.telegram\.org/, proxyBase)
    : url;

  if (!proxyBase || !proxyToken) {
    return fetch(target, init);
  }

  const headers = new Headers(init?.headers || undefined);
  headers.set("x-proxy-token", proxyToken);
  return fetch(target, { ...init, headers });
}
