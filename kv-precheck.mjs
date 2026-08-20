#!/usr/bin/env node
// ============================================================
// 远程 KV 连通性自检（docker-entrypoint 启动时调用）
//
// 两步检测：
//   1. HTTPS 证书链校验 —— 用系统 CA 库（node --use-openssl-ca），
//      与容器内 workerd 出站 TLS 校验行为一致；
//   2. 真实请求 GET {KV_ENDPOINT}/kv?limit=1 —— 验证网络 + 认证。
//
// 输出定位建议：
//   - "unable to get local issuer certificate" / "self-signed certificate"
//       → 反代证书链不完整（只发了叶子证书）或自签证书。
//         根治：反代改用 fullchain.pem（nginx: ssl_certificate 指向 fullchain）；
//         或将 CA 挂载进容器：-v ./ca.crt:/usr/local/share/ca-certificates/myca.crt:ro
//   - "certificate is not valid for ..." → 证书域名与访问域名不匹配
//   - ECONNREFUSED / ETIMEDOUT / ENOTFOUND → 网络 / DNS / 防火墙问题
//   - HTTP 401/403 → KV_AUTH_TOKEN 不正确
// ============================================================

const endpoint = String(process.env.KV_ENDPOINT || "").trim().replace(/\/+$/, "");
const token = String(process.env.KV_AUTH_TOKEN || "");

if (!endpoint) process.exit(0);
const base = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;

const log = (msg) => console.log(`[kv-precheck] ${msg}`);
const fail = (msg) => {
  console.error(`[kv-precheck] ✘ ${msg}`);
  process.exit(1);
};

const target = new URL(base);
const isHttps = target.protocol === "https:";

// ---------- 第 1 步：TLS 证书链校验（仅 https） ----------
if (isHttps) {
  const ok = await new Promise((resolve) => {
    import("node:tls").then(({ connect }) => {
      const sock = connect(
        {
          host: target.hostname,
          port: target.port || 443,
          servername: target.hostname,
          rejectUnauthorized: true, // 严格校验，模拟 workerd 行为
          autoSelectFamily: true, // IPv6 不通时自动回退 IPv4
        },
        () => {
          const c = sock.getPeerCertificate();
          const issuer = c?.issuer?.O || c?.issuer?.CN || "unknown";
          const subject = c?.subject?.CN || target.hostname;
          const until = c?.valid_to ? `，有效期至 ${c.valid_to}` : "";
          log(`✔ TLS 证书链验证通过（subject=${subject}，issuer=${issuer}${until}）`);
          sock.end();
          resolve(true);
        }
      );
      const timer = setTimeout(() => {
        sock.destroy();
        fail(`连接 ${target.hostname}:443 超时（防火墙拦截或服务未监听？）`);
      }, 10000);
      sock.on("error", (e) => {
        clearTimeout(timer);
        const code = e.code || "";
        if (/SELF_SIGNED/i.test(code) || /self-signed/i.test(e.message)) {
          fail(
            `证书为自签名，系统 CA 不信任。挂载 CA 后重启：\n` +
              `    -v /你的CA证书.crt:/usr/local/share/ca-certificates/myca.crt:ro\n` +
              `  （或改用公共 CA 证书，如 Let's Encrypt）`
          );
        } else if (
          code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
          /unable to get local issuer certificate/i.test(e.message)
        ) {
          fail(
            `证书链不完整：服务器只下发了叶子证书，缺少中间证书。\n` +
              `    根治（推荐）：反代改用 fullchain —— nginx 配置 ssl_certificate 指向 fullchain.pem 而非 cert.pem；\n` +
              `    Caddy 自动全链无需处理；certbot 用户使用 /etc/letsencrypt/live/<域名>/fullchain.pem`
          );
        } else if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
          fail(`证书域名不匹配：证书不覆盖 ${target.hostname}，检查反代 SNI/证书配置`);
        } else if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
          fail(`网络问题 ${code}：${e.message}（DNS 解析 / 防火墙 / 服务未启动？）`);
        } else {
          fail(`TLS 握手失败 ${code}: ${e.message}`);
        }
        resolve(false);
      });
      sock.on("close", () => clearTimeout(timer));
    });
  });
  if (!ok) process.exit(1);
} else {
  log(`endpoint 为 http://，跳过 TLS 校验`);
}

// ---------- 第 2 步：真实请求验证（网络 + 认证） ----------
try {
  const res = await fetch(`${base}/kv?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401 || res.status === 403) {
    fail(`KV 服务可达，但认证失败（HTTP ${res.status}）：检查 KV_AUTH_TOKEN`);
  } else if (res.status === 404) {
    fail(
      `KV 服务可达但路径 404（HTTP 404）：检查 KV_ENDPOINT 路径前缀（当前: ${base}，` +
        `若反代未挂 /tekv 前缀应填 origin，前缀通过 KV_BASE_PATH 追加）`
    );
  } else if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`KV 服务响应异常（HTTP ${res.status}）：${body.slice(0, 150)}`);
  } else {
    const data = await res.json().catch(() => null);
    const n = Array.isArray(data?.keys) ? data.keys.length : "?";
    log(`✔ KV 连通正常（list 返回 ${n} 个 key）`);
  }
} catch (e) {
  const code = e?.cause?.code || e?.code || "";
  if (/SELF_SIGNED|LEAF_SIGNATURE|local issuer/i.test(String(e?.cause?.message || e.message))) {
    // workerd 同款报错的兜底提示（正常应已在第 1 步拦截）
    fail(`证书不受信任（${code || e.message}）：反代补全 fullchain 或挂载自定义 CA`);
  } else {
    fail(`请求 ${base}/kv 失败 ${code}: ${e?.cause?.message || e.message}`);
  }
}
