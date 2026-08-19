var assert = require("assert");

const API_URL = "http://localhost:8788";
const PASSWORD = "123456";
const API_TOKEN = "123456";

const basicAuth = (user, pass) =>
  "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

function davFetch(path, options = {}) {
  return fetch(`${API_URL}/dav${path}`, options);
}

function authed(path, options = {}) {
  const headers = {
    Authorization: basicAuth("admin", PASSWORD),
    ...(options.headers || {}),
  };
  return davFetch(path, { ...options, headers });
}

// 生成确定性的测试数据（便于分片后校验内容）
function makePatternBuffer(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 7 + 13) % 251;
  }
  return buf;
}

describe("WebDAV", function () {
  this.timeout(120000);

  const SMALL_NAME = "webdav-test.txt";
  const SMALL_BODY = Buffer.from("hello webdav, this is otterhub!");

  // ---------- 认证 ----------
  describe("Authentication", function () {
    it("should reject unauthenticated PROPFIND with 401 + WWW-Authenticate", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 401);
      assert.ok(res.headers.get("www-authenticate").includes("Basic"));
    });

    it("should reject wrong password with 401", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: basicAuth("admin", "wrong-password"),
        },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 401);
    });

    it("should reject wrong Bearer token with 401", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: "Bearer invalid-token",
        },
      });
      assert.equal(res.status, 401);
    });

    it("should accept correct API_TOKEN as Bearer", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      assert.equal(res.status, 207);
    });

    it("should answer OPTIONS without auth (capability discovery)", async function () {
      const res = await davFetch("/", { method: "OPTIONS" });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("dav").includes("1"));
      assert.ok(res.headers.get("allow").includes("PROPFIND"));
      assert.ok(res.headers.get("allow").includes("PUT"));
    });
  });

  // ---------- PROPFIND ----------
  describe("PROPFIND", function () {
    it("should list root with four virtual collections (depth 1)", async function () {
      const res = await authed("/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      assert.ok(
        (res.headers.get("content-type") || "").includes("application/xml")
      );

      const xml = await res.text();
      for (const dir of ["img", "video", "audio", "doc"]) {
        assert.ok(
          xml.includes(`<D:href>/dav/${dir}/</D:href>`),
          `missing collection ${dir}`
        );
      }
      assert.ok(xml.includes("<D:collection/>"));
    });

    it("should return root itself for depth 0", async function () {
      const res = await authed("/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes("<D:href>/dav/</D:href>"));
      assert.ok(!xml.includes("<D:href>/dav/img/</D:href>"));
    });

    it("should return 404 for unknown path", async function () {
      const res = await authed("/nonexistent/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 404);
    });

    it("should return 404 for path traversal", async function () {
      const res = await authed("/img/..%2f..%2fetc", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 404);
    });
  });

  // ---------- PUT / GET / HEAD / DELETE ----------
  describe("PUT / GET / HEAD / DELETE", function () {
    it("should PUT a small file (201) and read it back verbatim", async function () {
      const put = await authed(`/doc/${SMALL_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: SMALL_BODY,
      });
      assert.equal(put.status, 201);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(get.status, 200);
      assert.equal(await get.text(), SMALL_BODY.toString());
    });

    it("should overwrite existing file (204) with new content", async function () {
      const newBody = Buffer.from("overwritten content v2");
      const put = await authed(`/doc/${SMALL_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: newBody,
      });
      assert.equal(put.status, 204);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(await get.text(), newBody.toString());
    });

    it("should PUT an empty file (0 bytes) and GET empty content back", async function () {
      const put = await authed("/doc/empty-marker.txt", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: new Uint8Array(0),
      });
      assert.equal(put.status, 201);

      const head = await authed("/doc/empty-marker.txt", { method: "HEAD" });
      assert.equal(head.status, 200);

      const get = await authed("/doc/empty-marker.txt");
      assert.equal(get.status, 200);
      // undici 会剥离空 body 响应的 Content-Length 头，故以 body 长度为准
      assert.equal((await get.arrayBuffer()).byteLength, 0);
      const cl = get.headers.get("content-length");
      assert.ok(cl === "0" || cl === null, `content-length=${cl}`);

      // PROPFIND 列表中大小为 0
      const pf = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await pf.text();
      assert.ok(xml.includes("empty-marker.txt"), "empty file in listing");
      assert.ok(
        xml.includes("<D:getcontentlength>0</D:getcontentlength>"),
        "empty file size 0 in listing"
      );

      const del = await authed("/doc/empty-marker.txt", { method: "DELETE" });
      assert.equal(del.status, 204);
    });

    it("should support HEAD with metadata headers", async function () {
      const res = await authed(`/doc/${SMALL_NAME}`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("last-modified"));
      assert.equal(
        parseInt(res.headers.get("content-length"), 10),
        "overwritten content v2".length
      );
    });

    it("should support Range requests (206)", async function () {
      const res = await authed(`/doc/${SMALL_NAME}`, {
        headers: { Range: "bytes=0-10" },
      });
      assert.equal(res.status, 206);
      const text = await res.text();
      assert.equal(text, "overwritten".slice(0, 11));
    });

    it("should show the file in collection PROPFIND", async function () {
      const res = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes(`<D:displayname>${SMALL_NAME}</D:displayname>`));
      assert.ok(xml.includes("<D:resourcetype/>"));
    });

    it("should DELETE file (204) then GET returns 404", async function () {
      const del = await authed(`/doc/${SMALL_NAME}`, { method: "DELETE" });
      assert.equal(del.status, 204);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(get.status, 404);
    });

    it("should PUT to collection path fail with 405", async function () {
      const res = await authed("/doc/", {
        method: "PUT",
        body: "x",
      });
      assert.equal(res.status, 405);
    });
  });

  // ---------- 大文件分片上传 ----------
  describe("Chunked PUT (21MB, 2 chunks)", function () {
    const BIG_NAME = "webdav-big-test.bin";
    const BIG_SIZE = 21 * 1024 * 1024; // 21MB -> 20MB + 1MB 两个分片
    let pattern;

    before(function () {
      pattern = makePatternBuffer(BIG_SIZE);
    });

    it("should upload via chunked path and return 201", async function () {
      const put = await authed(`/doc/${BIG_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: pattern,
      });
      assert.equal(put.status, 201);
    });

    it("should report correct size in PROPFIND", async function () {
      const res = await authed(`/doc/${BIG_NAME}`, {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(
        xml.includes(`<D:getcontentlength>${BIG_SIZE}</D:getcontentlength>`)
      );
    });

    it("should stream back full content with correct bytes", async function () {
      const res = await authed(`/doc/${BIG_NAME}`);
      assert.equal(res.status, 200);

      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, BIG_SIZE);
      // 抽查首、中、尾与分片边界
      for (const offset of [
        0,
        1024,
        10 * 1024 * 1024,
        20 * 1024 * 1024 - 1,
        BIG_SIZE - 1,
      ]) {
        assert.equal(
          buf[offset],
          pattern[offset],
          `byte mismatch at offset ${offset}`
        );
      }
    });

    it("should serve Range requests across chunk boundary (206)", async function () {
      const start = 20 * 1024 * 1024 - 4;
      const end = 20 * 1024 * 1024 + 3;
      const res = await authed(`/doc/${BIG_NAME}`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      assert.equal(res.status, 206);
      assert.ok(
        res.headers.get("content-range").startsWith(`bytes ${start}-${end}/`)
      );

      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, end - start + 1);
      for (let i = 0; i < buf.length; i++) {
        assert.equal(buf[i], pattern[start + i], "range byte mismatch");
      }
    });

    it("should delete big file afterwards", async function () {
      const del = await authed(`/doc/${BIG_NAME}`, { method: "DELETE" });
      assert.equal(del.status, 204);
    });
  });

  // ---------- MOVE / COPY ----------
  describe("MOVE / COPY", function () {
    const srcName = "webdav-move-src.txt";
    const renamed = "webdav-move-dst.txt";
    const copied = "webdav-copy-dst.txt";

    before(async function () {
      const put = await authed(`/doc/${srcName}`, {
        method: "PUT",
        body: Buffer.from("move-copy source content"),
      });
      assert.equal(put.status, 201);
    });

    it("should MOVE (rename) file within collection", async function () {
      const res = await authed(`/doc/${srcName}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/doc/${renamed}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 201);

      const old = await authed(`/doc/${srcName}`);
      assert.equal(old.status, 404);

      const now = await authed(`/doc/${renamed}`);
      assert.equal(now.status, 200);
      assert.equal(await now.text(), "move-copy source content");
    });

    it("should COPY file and keep both", async function () {
      const res = await authed(`/doc/${renamed}`, {
        method: "COPY",
        headers: {
          Destination: `/dav/doc/${copied}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 201);

      const a = await authed(`/doc/${renamed}`);
      const b = await authed(`/doc/${copied}`);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(await b.text(), "move-copy source content");
    });

    it("should reject MOVE onto existing destination without Overwrite: T (412)", async function () {
      const res = await authed(`/doc/${renamed}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/doc/${copied}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 412);
    });

    it("should allow cross-directory MOVE (real copy to target collection)", async function () {
      // 移动到 /dav/img/：真实复制到 img 类型 + 删除 doc 原件，目标列表可见
      const res = await authed(`/doc/${copied}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/img/${copied}`,
          Overwrite: "T",
        },
      });
      assert.equal(res.status, 201);

      const viaImg = await authed(`/img/${copied}`);
      assert.equal(viaImg.status, 200);
    });

    it("should MOVE to same resource return 403", async function () {
      const res = await authed(`/img/${copied}`, {
        method: "MOVE",
        headers: { Destination: `/dav/img/${copied}` },
      });
      assert.equal(res.status, 403);
    });

    it("should MOVE without Destination return 400", async function () {
      const res = await authed(`/img/${copied}`, { method: "MOVE" });
      assert.equal(res.status, 400);
    });

    after(async function () {
      await authed(`/doc/${renamed}`, { method: "DELETE" }).catch(() => {});
      await authed(`/img/${copied}`, { method: "DELETE" }).catch(() => {});
      await authed(`/doc/${copied}`, { method: "DELETE" }).catch(() => {});
    });
  });

  // ---------- 其他方法 ----------
  describe("MKCOL / PROPPATCH / LOCK / UNLOCK", function () {
    it("should reject MKCOL at root level with 405 (virtual collections only)", async function () {
      const res = await authed("/newfolder/", { method: "MKCOL" });
      assert.equal(res.status, 405);
    });

    it("should accept PROPPATCH with 207 multistatus", async function () {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">' +
        "<D:set><D:prop><Z:Win32LastModifiedTime>test</Z:Win32LastModifiedTime></D:prop></D:set>" +
        "</D:propertyupdate>";
      const res = await authed("/doc/", {
        method: "PROPPATCH",
        body,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes("HTTP/1.1 200 OK"));
      assert.ok(xml.includes("Win32LastModifiedTime"));
    });

    it("should grant LOCK with token (200)", async function () {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
        "<D:locktype><D:write/></D:locktype><D:owner>test</D:owner></D:lockinfo>";
      const res = await authed("/doc/locktest.txt", {
        method: "LOCK",
        headers: { Timeout: "Second-600" },
        body,
      });
      assert.equal(res.status, 200);
      const token = res.headers.get("lock-token");
      assert.ok(token && token.startsWith("<opaquelocktoken:"));

      const xml = await res.text();
      assert.ok(xml.includes("lockdiscovery"));

      const unlock = await authed("/doc/locktest.txt", {
        method: "UNLOCK",
        headers: { "Lock-Token": token },
      });
      assert.equal(unlock.status, 204);
    });

    it("should return 405 for unknown methods on /dav", async function () {
      const res = await authed("/doc/", { method: "SEARCH" });
      assert.ok([404, 405].includes(res.status));
    });
  });

  // ---------- 中文文件名与 HTML 索引 ----------
  describe("Unicode filenames & directory listing", function () {
    const cnName = "中文文件名测试.txt";

    it("should handle URL-encoded unicode filenames", async function () {
      const put = await authed(`/doc/${encodeURIComponent(cnName)}`, {
        method: "PUT",
        body: Buffer.from("中文内容 hello"),
      });
      assert.equal(put.status, 201);

      const propfind = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await propfind.text();
      assert.ok(xml.includes(encodeURIComponent(cnName)));
      assert.ok(xml.includes(`<D:displayname>${cnName}</D:displayname>`));

      const del = await authed(`/doc/${encodeURIComponent(cnName)}`, {
        method: "DELETE",
      });
      assert.equal(del.status, 204);
    });

    it("should render HTML index for collections", async function () {
      const res = await authed("/doc/");
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") || "").includes("text/html"));
      const html = await res.text();
      assert.ok(html.includes("OtterHub WebDAV"));
    });
  });

  // ---------- 嵌套目录（MKCOL / 目录 PROPFIND / 目录 MOVE / 目录 DELETE） ----------
  describe("Nested directories (alist mount scenarios)", function () {
    const DIR = "projects";
    const SUB = "projects/2024";
    const DEEP = "projects/2024/q1";

    before(async function () {
      // 清理历史残留
      await authed(`/doc/${DIR}/`, { method: "DELETE" }).catch(() => {});
    });

    after(async function () {
      // 递归清理本组创建的资源
      for (const p of [
        `/doc/${DIR}/`,
        `/doc/renamed/`,
        `/doc/auto/`,
        `/img/${DIR}/`,
        `/doc/目录测试/`,
        `/doc/moved-into-sub.txt`,
        `/doc/renamed.txt`,
      ]) {
        // 先删目录内文件（无递归删除 API，用已知文件名）
        await authed(p, { method: "DELETE" }).catch(() => {});
      }
      for (const f of [
        `/doc/${DIR}/readme.txt`,
        `/doc/${SUB}/plan.txt`,
        `/doc/${DEEP}/deep.bin`,
        `/doc/renamed/readme.txt`,
        `/doc/renamed/2024/plan.txt`,
        `/doc/auto/inner/file.txt`,
        `/img/${DIR}/readme.txt`,
        `/doc/目录测试/文件.txt`,
      ]) {
        await authed(f, { method: "DELETE" }).catch(() => {});
      }
      for (const d of [
        `/doc/${DEEP}/`,
        `/doc/${SUB}/`,
        `/doc/${DIR}/`,
        `/doc/renamed/2024/`,
        `/doc/renamed/`,
        `/doc/auto/inner/`,
        `/doc/auto/`,
        `/img/${DIR}/`,
        `/doc/目录测试/`,
      ]) {
        await authed(d, { method: "DELETE" }).catch(() => {});
      }
    });

    // ---- MKCOL ----
    it("should MKCOL create a subdirectory (201)", async function () {
      const res = await authed(`/doc/${DIR}/`, { method: "MKCOL" });
      assert.equal(res.status, 201);
    });

    it("should MKCOL nested subdirectory under existing parent (201)", async function () {
      const res = await authed(`/doc/${SUB}/`, { method: "MKCOL" });
      assert.equal(res.status, 201);
    });

    it("should reject MKCOL on existing directory (405)", async function () {
      const res = await authed(`/doc/${DIR}/`, { method: "MKCOL" });
      assert.equal(res.status, 405);
    });

    it("should reject MKCOL when parent missing (409)", async function () {
      const res = await authed("/doc/ghost/deep/", { method: "MKCOL" });
      assert.equal(res.status, 409);
    });

    it("should reject MKCOL with request body (415)", async function () {
      const res = await authed("/doc/bodydir/", {
        method: "MKCOL",
        body: "<mkcol/>",
      });
      assert.equal(res.status, 415);
    });

    it("should reject MKCOL with path traversal (405)", async function () {
      const res = await authed("/doc/..%2Fevil/", { method: "MKCOL" });
      assert.equal(res.status, 405);
    });

    // ---- 空目录 PROPFIND ----
    it("should PROPFIND empty directory (207, self only)", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes(`<D:href>/dav/doc/${DIR}/</D:href>`));
      assert.ok(xml.includes("<D:collection/>"));
    });

    it("should PROPFIND directory without trailing slash (207)", async function () {
      const res = await authed(`/doc/${DIR}`, {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes(`<D:href>/dav/doc/${DIR}/</D:href>`));
    });

    it("should PROPFIND return 404 for missing directory", async function () {
      const res = await authed("/doc/no-such-dir/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 404);
    });

    // ---- 嵌套上传/下载 ----
    it("should PUT file into subdirectory (201) and GET it back", async function () {
      const body = "nested readme content";
      const put = await authed(`/doc/${DIR}/readme.txt`, {
        method: "PUT",
        body,
      });
      assert.equal(put.status, 201);

      const get = await authed(`/doc/${DIR}/readme.txt`);
      assert.equal(get.status, 200);
      assert.equal(await get.text(), body);
    });

    it("should PUT file into deep nested directory (auto-created)", async function () {
      const put = await authed(`/doc/${DEEP}/deep.bin`, {
        method: "PUT",
        body: Buffer.from([1, 2, 3, 4, 5]),
      });
      assert.equal(put.status, 201);
    });

    it("should PUT create implicit directories (no MKCOL needed)", async function () {
      const put = await authed("/doc/auto/inner/file.txt", {
        method: "PUT",
        body: "implicit dir",
      });
      assert.equal(put.status, 201);

      const list = await authed("/doc/auto/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await list.text();
      assert.ok(
        xml.includes("<D:href>/dav/doc/auto/inner/</D:href>"),
        "implicit subdir visible"
      );
    });

    // ---- 目录列举 ----
    it("should list subdirectory with nested dirs and files (depth 1)", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes(`<D:href>/dav/doc/${DIR}/readme.txt</D:href>`));
      assert.ok(xml.includes(`<D:href>/dav/doc/${SUB}/</D:href>`));
      assert.ok(
        !xml.includes(`<D:href>/dav/doc/${DEEP}/</D:href>`),
        "grandchild dir not at this level"
      );
    });

    it("should show subdirectory in parent collection listing", async function () {
      const res = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await res.text();
      assert.ok(xml.includes(`<D:href>/dav/doc/${DIR}/</D:href>`));
    });

    it("should HEAD file in nested path with correct size", async function () {
      const res = await authed(`/doc/${DIR}/readme.txt`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-length"), "21"); // "nested readme content"
    });

    it("should GET directory HTML index for subdirectory", async function () {
      const res = await authed(`/doc/${DIR}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes("readme.txt"));
      assert.ok(html.includes("2024/"));
    });

    // ---- 目录内文件 MOVE ----
    it("should MOVE file into subdirectory", async function () {
      const put = await authed("/doc/plain-file.txt", {
        method: "PUT",
        body: "to be moved into subdir",
      });
      assert.equal(put.status, 201);

      const mv = await authed("/doc/plain-file.txt", {
        method: "MOVE",
        headers: { Destination: `/dav/doc/${SUB}/plan.txt`, Overwrite: "F" },
      });
      assert.equal(mv.status, 201);

      const viaNew = await authed(`/doc/${SUB}/plan.txt`);
      assert.equal(viaNew.status, 200);
      assert.equal(await viaNew.text(), "to be moved into subdir");

      const viaOld = await authed("/doc/plain-file.txt");
      assert.equal(viaOld.status, 404);
    });

    // ---- 目录 MOVE ----
    it("should MOVE (rename) directory within same collection", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "MOVE",
        headers: { Destination: `/dav/doc/renamed/`, Overwrite: "F" },
      });
      assert.equal(res.status, 201);

      // 目录内容经新路径可达
      const readme = await authed("/doc/renamed/readme.txt");
      assert.equal(readme.status, 200);

      const deep = await authed(`/doc/renamed/2024/q1/deep.bin`);
      assert.equal(deep.status, 200);

      // 旧路径不可达
      const oldList = await authed(`/doc/${DIR}/`, {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(oldList.status, 404);

      // 新目录可列出子目录
      const list = await authed("/doc/renamed/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await list.text();
      assert.ok(xml.includes("<D:href>/dav/doc/renamed/2024/</D:href>"));
    });

    it("should MOVE directory without trailing slash (client variant)", async function () {
      // 改回原名（无尾斜杠形式）
      const res = await authed(`/doc/renamed`, {
        method: "MOVE",
        headers: { Destination: `/dav/doc/${DIR}`, Overwrite: "F" },
      });
      assert.equal(res.status, 201);
      const readme = await authed(`/doc/${DIR}/readme.txt`);
      assert.equal(readme.status, 200);
    });

    it("should reject directory MOVE onto existing destination (412)", async function () {
      const mk = await authed("/doc/occupied/", { method: "MKCOL" });
      assert.equal(mk.status, 201);
      const res = await authed(`/doc/${DIR}/`, {
        method: "MOVE",
        headers: { Destination: "/dav/doc/occupied/", Overwrite: "F" },
      });
      assert.equal(res.status, 412);
      await authed("/doc/occupied/", { method: "DELETE" });
    });

    it("should reject directory MOVE into itself (409)", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "MOVE",
        headers: { Destination: `/dav/doc/${DIR}/2024/inside/` },
      });
      assert.equal(res.status, 409);
    });

    // ---- 跨类型目录 MOVE ----
    it("should MOVE directory across collections (doc → img)", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "MOVE",
        headers: { Destination: `/dav/img/${DIR}/`, Overwrite: "F" },
      });
      assert.equal(res.status, 201);

      // 新路径可访问
      const readme = await authed(`/img/${DIR}/readme.txt`);
      assert.equal(readme.status, 200);
      assert.equal(await readme.text(), "nested readme content");

      // 目标目录列表可见（跨类型移动是真实复制）
      const list = await authed(`/img/${DIR}/`, {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await list.text();
      assert.ok(xml.includes(`<D:href>/dav/img/${DIR}/readme.txt</D:href>`));

      // 旧路径失效
      const old = await authed(`/doc/${DIR}/readme.txt`);
      assert.equal(old.status, 404);

      // 移回 doc 以便后续清理
      const back = await authed(`/img/${DIR}/`, {
        method: "MOVE",
        headers: { Destination: `/dav/doc/${DIR}/`, Overwrite: "F" },
      });
      assert.equal(back.status, 201);
    });

    // ---- 目录 COPY ----
    it("should reject COPY on directory (400, client must recurse)", async function () {
      const res = await authed(`/doc/${DIR}/`, {
        method: "COPY",
        headers: { Destination: "/dav/doc/copydir/" },
      });
      assert.equal(res.status, 400);
    });

    // ---- 目录 DELETE ----
    it("should reject DELETE on non-empty directory (409)", async function () {
      const res = await authed(`/doc/${DIR}/`, { method: "DELETE" });
      assert.equal(res.status, 409);
    });

    it("should DELETE empty deep directory (204) then PROPFIND 404", async function () {
      // 标准 MKCOL 需逐级创建
      assert.equal(
        (await authed("/doc/empty-dir/", { method: "MKCOL" })).status,
        201
      );
      assert.equal(
        (await authed("/doc/empty-dir/l1/", { method: "MKCOL" })).status,
        201
      );
      const mk = await authed("/doc/empty-dir/l1/l2/", { method: "MKCOL" });
      assert.equal(mk.status, 201);
      // 删最深的空目录
      const del = await authed("/doc/empty-dir/l1/l2/", { method: "DELETE" });
      assert.equal(del.status, 204);
      const pf = await authed("/doc/empty-dir/l1/l2/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(pf.status, 404);
      // 清理剩余空目录
      await authed("/doc/empty-dir/l1/", { method: "DELETE" });
      await authed("/doc/empty-dir/", { method: "DELETE" });
    });

    // ---- 中文目录名 ----
    it("should support unicode directory names end-to-end", async function () {
      const dir = encodeURIComponent("目录测试");
      const file = encodeURIComponent("文件.txt");
      const mk = await authed(`/doc/${dir}/`, { method: "MKCOL" });
      assert.equal(mk.status, 201);

      const put = await authed(`/doc/${dir}/${file}`, {
        method: "PUT",
        body: "中文目录内容",
      });
      assert.equal(put.status, 201);

      const list = await authed(`/doc/${dir}/`, {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await list.text();
      assert.ok(xml.includes(`<D:href>/dav/doc/${dir}/${file}</D:href>`));

      const get = await authed(`/doc/${dir}/${file}`);
      assert.equal(await get.text(), "中文目录内容");
    });

    // ---- 清理：删除本组全部内容 ----
    it("cleanup: delete all nested test resources", async function () {
      // 先删文件，再删目录（空目录语义）
      const files = [
        `/doc/${DIR}/readme.txt`,
        `/doc/${SUB}/plan.txt`,
        `/doc/${DEEP}/deep.bin`,
        "/doc/auto/inner/file.txt",
        `/doc/目录测试/文件.txt`,
      ];
      for (const f of files) {
        const del = await authed(f, { method: "DELETE" });
        assert.equal(del.status, 204, `delete ${f}`);
      }
      const dirs = [
        `/doc/${DEEP}/`,
        `/doc/${SUB}/`,
        `/doc/${DIR}/`,
        "/doc/auto/inner/",
        "/doc/auto/",
        "/doc/目录测试/",
      ];
      for (const d of dirs) {
        const del = await authed(d, { method: "DELETE" });
        // 显式目录标记 → 204；隐式目录（无标记）在文件删除后自动消失 → 404
        assert.ok(
          [204, 404].includes(del.status),
          `delete ${d}: ${del.status}`
        );
      }
      const pf = await authed(`/doc/${DIR}/`, {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(pf.status, 404);
    });
  });
});
