/**
 * Telegram API 代理支持（自部署场景，多代理轮转版）
 *
 * 配置 TG_API_BASE 后，所有对 api.telegram.org 的请求改走自建代理，
 * 例如 Cloudflare Pages 上的 otterhub-tg-proxy：https://cf.totootao.top/tg
 * 用于国内服务器等无法直连 Telegram API 的部署环境。
 *
 * 多代理（v2 新增）：TG_API_BASE 支持以下四种写法（均向后兼容）
 *   1. 单地址          "https://cf.totootao.top/tg"
 *   2. 逗号分隔多地址  "https://cf1.totootao.top/tg,https://cf2.totootao.top/tg"
 *   3. JSON 字符串数组 '["https://cf1.totootao.top/tg","https://cf2.totootao.top/tg"]'
 *   4. JSON 对象数组   '[{"base":"https://cf1/tg","token":"t1"},{"base":"https://hk-vps/tg"}]'
 * 代理之间按请求轮转（isolate 随机相位，跨实例不聚堆），
 * 连续失败 2 次的代理冷却 30s，期间轮转自动跳过；全部冷却时无视冷却继续尝试。
 * TG_PROXY_TOKEN 作为全局兜底令牌，对象数组可按代理单独指定 token。
 *
 * 两个变量均未配置时行为与原版完全一致（直连 api.telegram.org）。
 */

interface ProxyTarget {
  base: string;
  token: string | null;
}

/** 冷却判定：连续失败次数阈值与冷却时长 */
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 30_000;

interface TargetHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
}

const globalForProxy = globalThis as unknown as {
  __otterhubProxyTargets?: ProxyTarget[];
  __otterhubProxyHealth?: Map<ProxyTarget, TargetHealth>;
  __otterhubProxyRR?: { phase: number; counter: number };
};

let targets: ProxyTarget[] = globalForProxy.__otterhubProxyTargets ?? [];
const health: Map<ProxyTarget, TargetHealth> =
  globalForProxy.__otterhubProxyHealth ?? new Map();
// isolate 随机相位 + 计数器（与 tg-pool 同套路），保证多 isolate 不聚堆同一代理
let rr: { phase: number; counter: number } =
  globalForProxy.__otterhubProxyRR ?? {
    phase: Math.floor(Math.random() * 1_000_000),
    counter: 0,
  };
globalForProxy.__otterhubProxyTargets = targets;
globalForProxy.__otterhubProxyHealth = health;
globalForProxy.__otterhubProxyRR = rr;

/** 解析 TG_API_BASE 为代理目标数组 */
export function parseProxyConfig(
  rawBase: string | undefined,
  rawToken: string | undefined
): ProxyTarget[] {
  const fallbackToken = rawToken?.trim() || null;
  const trimmed = rawBase?.trim();
  if (!trimmed) return [];

  const parsed: ProxyTarget[] = [];

  // JSON 数组（字符串或对象）
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      for (const item of arr) {
        if (typeof item === "string" && item.trim()) {
          parsed.push({ base: item.trim().replace(/\/+$/, ""), token: fallbackToken });
        } else if (item && typeof item === "object") {
          const obj = item as { base?: string; token?: string };
          if (obj.base?.trim()) {
            parsed.push({
              base: obj.base.trim().replace(/\/+$/, ""),
              token: obj.token?.trim() || fallbackToken,
            });
          }
        }
      }
    } catch {
      console.error("[tg-proxy] TG_API_BASE JSON 解析失败，按单地址处理");
    }
    if (parsed.length > 0) return parsed;
    // JSON 解析出空数组 → 继续按逗号/单地址逻辑兜底
  }

  // 逗号分隔或单地址
  for (const part of trimmed.split(",")) {
    const b = part.trim().replace(/\/+$/, "");
    if (b) parsed.push({ base: b, token: fallbackToken });
  }
  return parsed;
}

/** 每个请求开始时由全局中间件调用，注入当前环境配置 */
export function configureTgProxy(env: {
  TG_API_BASE?: string;
  TG_PROXY_TOKEN?: string;
}): void {
  targets = parseProxyConfig(env.TG_API_BASE, env.TG_PROXY_TOKEN);
  globalForProxy.__otterhubProxyTargets = targets;
  health.clear();
  rr = { phase: Math.floor(Math.random() * 1_000_000), counter: 0 };
  globalForProxy.__otterhubProxyRR = rr;
  if (targets.length > 1) {
    console.log(
      `[tg-proxy] 多代理轮转已启用：${targets.length} 个（${targets
        .map((t) => hostOf(t.base))
        .join(" / ")}）`
    );
  }
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** 轮转选择代理：优先健康代理，全部冷却时无视冷却 */
function pickTarget(): ProxyTarget | null {
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];

  const now = Date.now();
  const idx = (rr.phase + rr.counter++) % targets.length;

  // 首选轮转到的目标；若其处于冷却期，向后找一个不在冷却期的
  for (let i = 0; i < targets.length; i++) {
    const t = targets[(idx + i) % targets.length];
    const h = health.get(t);
    if (!h || h.cooldownUntil < now) return t;
  }
  return targets[idx]; // 全部冷却：仍按轮转尝试
}

/** 记录代理失败；达阈值进入冷却并告警一次 */
function markFailure(t: ProxyTarget, reason: string): void {
  if (targets.length <= 1) return; // 单代理无需健康切换，交给上层重试
  const h = health.get(t) ?? { consecutiveFailures: 0, cooldownUntil: 0 };
  h.consecutiveFailures += 1;
  if (h.consecutiveFailures >= FAILURE_THRESHOLD) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    h.consecutiveFailures = 0; // 冷却结束后重新计数
    console.warn(
      `[tg-proxy] 代理 ${hostOf(t.base)} 连续失败，冷却 ${COOLDOWN_MS / 1000}s（${reason}）`
    );
  }
  health.set(t, h);
}

/** 记录代理成功（清除失败计数） */
function markSuccess(t: ProxyTarget): void {
  const h = health.get(t);
  if (h && h.consecutiveFailures > 0) {
    h.consecutiveFailures = 0;
    health.set(t, h);
  }
}

/** 包装 fetch：改写 api.telegram.org 基址并附加代理鉴权头，多代理自动轮转 */
export function tgFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = pickTarget();

  // 无代理：直连（原版行为）
  if (!target) {
    return fetch(url, init);
  }

  const rewritten = url.replace(/^https:\/\/api\.telegram\.org/, target.base);

  let headers: Headers | undefined;
  if (target.token) {
    headers = new Headers(init?.headers || undefined);
    headers.set("x-proxy-token", target.token);
  }

  return fetch(rewritten, { ...init, headers }).then(
    (resp) => {
      // 5xx 视为代理侧故障（522/523/524 为 CF 回源/超时典型码），进入健康统计；
      // 仍把响应交回调用方，由其既有重试逻辑决定后续动作
      if (resp.status >= 502) {
        markFailure(target, `HTTP ${resp.status}`);
      } else {
        markSuccess(target);
      }
      return resp;
    },
    (err) => {
      markFailure(target, "network error");
      throw err;
    }
  );
}

/** 当前生效的代理列表（运维/调试用） */
export function getProxyTargets(): ReadonlyArray<Readonly<ProxyTarget>> {
  return targets;
}
