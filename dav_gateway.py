#!/usr/bin/env python3
"""
OtterHub WebDAV 中转网关
========================

用途：突破 Cloudflare 免费计划对单个请求 100MB 请求体的限制，
      让 WebDAV 客户端（Windows 映射驱动器 / macOS Finder / rclone 等）
      可以直接上传大文件（上限由 OtterHub 的 MAX_CHUNK_NUM 决定，当前 12GB）。

原理：
  上传 PUT  → 流式接收请求体，按 20MB 切片，逐片调用 OtterHub 的
              /upload/chunk/init + /upload/chunk（每个分片一个独立请求）
  下载 GET  → 按客户端 Range 计算区间，切成与存储分片对齐的 20MB 子段，
              逐段向 OtterHub 发 Range 请求并流式转发（每次 CF 调用只碰
              1 个存储分片，永不触发子请求配额）
  其他方法 → 直接反向代理到 OtterHub 的 /dav 端点

部署（与 kv_server.py 同风格，跑在家宽服务器上即可）：
    python3 dav_gateway.py --port 5789 \
        --otterhub https://otterhu.totootao.top \
        --api-token YOUR_API_TOKEN

    # 或用环境变量：OTTERHUB_URL / API_TOKEN

依赖：pip install flask requests
Nginx 反代示例（IPv6 域名 w.totootao.top，注意关闭请求体大小限制）：
    location /davgw/ {
        proxy_pass http://127.0.0.1:5789/;
        proxy_request_buffering off;   # 关键：流式转发上传体，不吃磁盘
        proxy_buffering off;           # 关键：流式转发下载体
        client_max_body_size 0;        # 关键：不限制上传大小
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

客户端连接（示例）：https://w.totootao.top/davgw/dav/
"""

import argparse
import json
import os
import re
import sys
import time

import requests
from flask import Flask, Response, request, stream_with_context

DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024  # 必须与 OtterHub MAX_CHUNK_SIZE 一致（TG Bot 限制）

app = Flask(__name__)

CONFIG = {
    "otterhub": "",      # OtterHub 站点地址，如 https://otterhu.totootao.top
    "api_token": "",     # OtterHub 的 API_TOKEN（用于分片上传内部 API）
    "chunk_size": DEFAULT_CHUNK_SIZE,
}

# 复用连接的会话（对 CF / 自建 KV 保活）
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "OtterHub-DAV-Gateway/1.0"})

FILE_TYPE_DIRS = {"img", "video", "audio", "doc"}
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length",
}


def auth_headers(extra=None):
    h = {"Authorization": f"Bearer {CONFIG['api_token']}"}
    if extra:
        h.update(extra)
    return h


def proxy_method(path, method=None, timeout=(10, 120)):
    """把请求原样反向代理到 OtterHub /dav（透传认证头）"""
    method = method or request.method
    url = f"{CONFIG['otterhub']}/dav/{path}"
    fwd_headers = {
        k: v for k, v in request.headers if k.lower() not in HOP_HEADERS
    }
    try:
        upstream = SESSION.request(
            method, url,
            headers=fwd_headers,
            data=request.stream if request.content_length else None,
            stream=True,
            timeout=timeout,
            allow_redirects=False,
        )
    except requests.RequestException as e:
        return Response(f"gateway: upstream error: {e}", status=502)

    resp_headers = [
        (k, v) for k, v in upstream.headers.items()
        if k.lower() not in HOP_HEADERS
    ]
    return Response(
        upstream.iter_content(chunk_size=256 * 1024),
        status=upstream.status_code,
        headers=resp_headers,
    )


def parse_dav_file_path():
    """解析 /dav/{type}/{name}，返回 (file_type, file_name) 或 None"""
    m = re.match(r"^/dav/(img|video|audio|doc)/([^/]+)$", request.path)
    if not m:
        return None
    return m.group(1), m.group(2)


def propfind_size(file_type, file_name, auth):
    """向 OtterHub 查询文件大小，不存在返回 None，出错抛异常"""
    url = f"{CONFIG['otterhub']}/dav/{file_type}/{file_name}"
    r = SESSION.request(
        "PROPFIND", url,
        headers={**auth, "Depth": "0"},
        data='<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/></D:prop></D:propfind>',
        timeout=(10, 60),
    )
    if r.status_code == 404:
        return None
    if r.status_code != 207:
        raise RuntimeError(f"PROPFIND failed: HTTP {r.status_code}")
    m = re.search(r"<D:getcontentlength>(\d+)</D:getcontentlength>", r.text)
    if not m:
        raise RuntimeError("PROPFIND response missing getcontentlength")
    return int(m.group(1))


def chunk_upload(file_type, file_name, stream, total_size, on_progress=None):
    """核心：流式读取 body，按 chunk_size 切片，通过 init + chunk API 上传"""
    chunk_size = CONFIG["chunk_size"]
    total_chunks = (total_size + chunk_size - 1) // chunk_size

    # 1. init
    init_url = f"{CONFIG['otterhub']}/upload/chunk/init"
    for attempt in range(3):
        try:
            r = SESSION.post(init_url, headers=auth_headers({"Content-Type": "application/json"}), json={
                "fileType": file_type,
                "fileName": file_name,
                "fileSize": total_size,
                "totalChunks": total_chunks,
            }, timeout=(10, 60))
            if r.status_code == 200:
                break
        except requests.RequestException:
            pass
        time.sleep(1.5 * (attempt + 1))
    else:
        raise RuntimeError(f"chunk init failed: HTTP {r.status_code} {r.text[:200]}")

    # 响应为 {success, data: "<key>"}（或 {success, data: {key}}），两种形态兼容
    key = None
    try:
        data = r.json().get("data")
        key = data if isinstance(data, str) else (data or {}).get("key")
    except Exception:
        key = None
    if not key:
        raise RuntimeError(f"chunk init response missing key: {r.text[:200]}")

    # 2. 逐片上传
    chunk_url = f"{CONFIG['otterhub']}/upload/chunk"
    received = 0
    index = 0
    t0 = time.time()
    try:
        while received < total_size:
            want = min(chunk_size, total_size - received)
            buf = b""
            while len(buf) < want:
                part = stream.read(want - len(buf))
                if not part:
                    break
                buf += part
            if len(buf) != want:
                raise RuntimeError(
                    f"client body shorter than Content-Length: got {received + len(buf)}, declared {total_size}"
                )

            ok = False
            last_err = ""
            # 503/502 通常是 Worker 1102 资源耗尽：隔离实例堆内垃圾触发大 GC 计入 CPU。
            # 实例池恢复需 2~5 分钟，退避序列累计约 7 分钟确保跨过恢复周期；
            # 分片上传服务端幂等（重复分片自动跳过），长退避重发安全。
            backoffs = [15, 30, 60, 120, 180]
            for attempt in range(len(backoffs) + 1):
                try:
                    files = {"chunkFile": (file_name, buf)}
                    resp = SESSION.post(
                        chunk_url,
                        headers=auth_headers(),
                        data={"key": key, "chunkIndex": str(index)},
                        files=files,
                        timeout=(10, 600),
                    )
                    if resp.status_code == 200:
                        ok = True
                        break
                    last_err = f"HTTP {resp.status_code} {resp.text[:200]}"
                    if resp.status_code in (502, 503, 504) and attempt < len(backoffs):
                        wait = backoffs[attempt]
                        print(f"[gateway] chunk {index}: {last_err[:80]}... "
                              f"等 {wait}s 后重试 ({attempt + 1}/{len(backoffs)})", file=sys.stderr, flush=True)
                        time.sleep(wait)
                        continue
                except requests.RequestException as e:
                    last_err = str(e)
                if attempt < len(backoffs):
                    time.sleep(backoffs[attempt])
            if not ok:
                raise RuntimeError(f"chunk {index} upload failed: {last_err[:300]}")

            received += want
            index += 1
            if on_progress:
                on_progress(index, total_chunks, received, time.time() - t0)
    except Exception:
        # 尽力清理未完成的上传记录
        try:
            SESSION.delete(f"{CONFIG['otterhub']}/file/{key}", headers=auth_headers(), timeout=10)
        except Exception:
            pass
        raise

    return key, index


def parse_client_range(total):
    """解析客户端 Range 头，返回 (start, end) 或 None（无 Range / 无法解析）"""
    h = request.headers.get("Range", "")
    m = re.match(r"^bytes=(\d*)-(\d*)$", h.strip())
    if not m:
        return None
    s_s, e_s = m.group(1), m.group(2)
    if s_s == "" and e_s == "":
        return None
    if s_s == "":  # 后缀区间 bytes=-N
        n = int(e_s)
        start, end = max(0, total - n), total - 1
    else:
        start = int(s_s)
        end = int(e_s) if e_s else total - 1
    if start > end or start >= total:
        return "invalid"
    return start, min(end, total - 1)


# ---------------- WebDAV 路由 ----------------

@app.route("/dav", methods=["OPTIONS"])
@app.route("/dav/", methods=["OPTIONS"])
@app.route("/dav/<path:sub>", methods=["OPTIONS"])
def dav_options(sub=None):
    return proxy_method(sub or "")


@app.route("/dav", methods=["PROPFIND", "PROPPATCH", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK", "UNLOCK"])
@app.route("/dav/", methods=["PROPFIND", "PROPPATCH", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK", "UNLOCK"])
@app.route("/dav/<path:sub>", methods=["PROPFIND", "PROPPATCH", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK", "UNLOCK"])
def dav_passthrough(sub=None):
    return proxy_method(sub or "")


@app.route("/dav/<file_type>/<file_name>", methods=["HEAD"])
def dav_head(file_type, file_name):
    return proxy_method(f"{file_type}/{file_name}", method="HEAD")


@app.route("/dav/<file_type>/<file_name>", methods=["GET"])
def dav_get(file_type, file_name):
    """大文件下载：分段 Range 拼接流式转发"""
    fwd_auth = {"Authorization": request.headers.get("Authorization", "")}
    try:
        total = propfind_size(file_type, file_name, fwd_auth)
    except RuntimeError as e:
        return Response(f"gateway: {e}", status=502)
    if total is None:
        return Response("Not Found", status=404)

    rng = parse_client_range(total)
    if rng == "invalid":
        return Response(
            "Requested Range Not Satisfiable",
            status=416,
            headers={"Content-Range": f"bytes */{total}"},
        )

    if rng is None:
        start, end, status = 0, total - 1, 200
    else:
        start, end, status = rng[0], rng[1], 206

    chunk_size = CONFIG["chunk_size"]
    seg_start = start - (start % chunk_size)  # 与存储分片对齐

    def generate():
        pos = seg_start
        while pos <= end:
            seg_end = min(pos + chunk_size - 1, total - 1)
            a, b = max(pos, start), min(seg_end, end)
            url = f"{CONFIG['otterhub']}/dav/{file_type}/{file_name}"
            headers = {**fwd_auth, "Range": f"bytes={a}-{b}"}
            with SESSION.get(url, headers=headers, stream=True, timeout=(10, 600)) as r:
                if r.status_code not in (200, 206):
                    raise RuntimeError(f"segment fetch failed: HTTP {r.status_code}")
                remaining = b - a + 1
                for part in r.iter_content(chunk_size=256 * 1024):
                    if not part:
                        continue
                    if remaining <= 0:
                        break
                    if len(part) > remaining:
                        part = part[:remaining]
                    remaining -= len(part)
                    yield part
                    if remaining <= 0:
                        break
            pos = seg_end + 1

    headers = {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        **({"Content-Range": f"bytes {start}-{end}/{total}"} if status == 206 else {}),
    }
    return Response(
        stream_with_context(generate()),
        status=status,
        headers=headers,
    )


@app.route("/dav/<file_type>/<file_name>", methods=["PUT"])
def dav_put(file_type, file_name):
    """大文件上传：流式接收 + 分片编排"""
    if file_type not in FILE_TYPE_DIRS:
        return Response("Unknown collection", status=405)

    total = request.content_length
    if not total:
        # WebDAV 客户端都会带 Content-Length；chunked body 直接要求补头
        return Response("Length Required (gateway streams by Content-Length)", status=411)

    max_size = CONFIG["chunk_size"] * 600  # 与 OtterHub MAX_CHUNK_NUM 对齐
    if total > max_size:
        return Response(f"Payload Too Large (>{max_size})", status=413)

    fwd_auth = {"Authorization": request.headers.get("Authorization", "")}
    existed = False
    try:
        existed = propfind_size(file_type, file_name, fwd_auth) is not None
    except RuntimeError:
        pass  # 查询失败不阻塞上传，按新建处理

    def progress(idx, total_chunks, received, elapsed):
        speed = received / elapsed / 1024 / 1024 if elapsed > 0 else 0
        print(f"[gateway] {file_name}: chunk {idx}/{total_chunks} "
              f"({received / 1024 / 1024:.1f}MB, {speed:.1f}MB/s)", file=sys.stderr, flush=True)

    try:
        _, n = chunk_upload(file_type, file_name, request.stream, total, progress)
    except RuntimeError as e:
        return Response(f"gateway: upload failed: {e}", status=502)

    # 覆盖旧文件（与 CF WebDAV 语义一致：旧文件进回收站）
    if existed:
        try:
            SESSION.request("DELETE", f"{CONFIG['otterhub']}/dav/{file_type}/{file_name}",
                            headers=fwd_auth, timeout=(10, 120))
        except requests.RequestException:
            pass
        return Response(status=204)
    return Response(status=201)


@app.route("/health", methods=["GET"])
def health():
    try:
        r = SESSION.get(f"{CONFIG['otterhub']}/health", timeout=(5, 15))
        upstream = r.status_code
    except requests.RequestException:
        upstream = "unreachable"
    return json.dumps({
        "status": "ok",
        "upstream": CONFIG["otterhub"],
        "upstream_health": upstream,
        "chunk_size_mb": CONFIG["chunk_size"] // 1024 // 1024,
        "max_upload_gb": CONFIG["chunk_size"] * 600 / 1024 / 1024 / 1024,
    })


def main():
    parser = argparse.ArgumentParser(description="OtterHub WebDAV 中转网关")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5789)))
    parser.add_argument("--host", default="::", help="监听地址（默认 :: 双栈）")
    parser.add_argument("--otterhub", default=os.environ.get("OTTERHUB_URL", ""),
                        help="OtterHub 站点地址，如 https://otterhu.totootao.top")
    parser.add_argument("--api-token", default=os.environ.get("API_TOKEN", ""),
                        help="OtterHub 的 API_TOKEN")
    parser.add_argument("--chunk-mb", type=int, default=int(os.environ.get("CHUNK_MB", "20")),
                        help="分片大小 MB（必须与 OtterHub MAX_CHUNK_SIZE 一致）")
    args = parser.parse_args()

    if not args.otterhub or not args.api_token:
        parser.error("--otterhub 与 --api-token 必须提供（或设 OTTERHUB_URL/API_TOKEN 环境变量）")

    CONFIG["otterhub"] = args.otterhub.rstrip("/")
    CONFIG["api_token"] = args.api_token
    CONFIG["chunk_size"] = args.chunk_mb * 1024 * 1024

    print(f"[gateway] upstream = {CONFIG['otterhub']}", file=sys.stderr)
    print(f"[gateway] listen   = [{args.host}]:{args.port}", file=sys.stderr)
    from werkzeug.serving import run_simple
    run_simple(args.host, args.port, app, threaded=True)


if __name__ == "__main__":
    main()
