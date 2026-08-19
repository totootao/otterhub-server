const CACHE_NAME = "otterhub-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  "/",
  "/login",
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon.svg",
  "/apple-icon.png",
  "/icons/pwa-192.png",
  "/icons/pwa-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }),
      ),
    ).then(() => self.clients.claim()),
  );
});

function isStaticAsset(requestUrl, request) {
  if (request.headers.has("range")) {
    return false;
  }

  if (requestUrl.pathname.startsWith("/_next/")) {
    return true;
  }

  return [
    "/manifest.webmanifest",
    "/favicon.ico",
    "/favicon.svg",
    "/apple-icon.png",
    "/icons/pwa-192.png",
    "/icons/pwa-512.png",
  ].includes(requestUrl.pathname);
}

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cachedPage = await cache.match(request);
    if (cachedPage) {
      return cachedPage;
    }

    const offlinePage = await cache.match(OFFLINE_URL);
    if (offlinePage) {
      return offlinePage;
    }

    throw error;
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    void fetch(request).then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
    }).catch(() => undefined);

    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isStaticAsset(requestUrl, request)) {
    event.respondWith(handleStaticAsset(request));
  }
});
