/* Offline support for the Tesla Android web frontend.
 *
 * After one online visit, every file this page needs is kept in the
 * browser's cache, so the page opens with no internet at all. Requests to
 * the box (API, display, audio, touch, GPS) go to a different address and
 * are never touched here.
 *
 * The deploy step fills in VERSION and PRECACHE. Without it (local copies)
 * the worker falls back to caching files as they are fetched.
 */
const VERSION = "dev";
const PRECACHE = [];

const CACHE_PREFIX = "ta-";
const CACHE = CACHE_PREFIX + VERSION;
const NAVIGATION_TIMEOUT_MS = 3000;

// Directory this worker lives in, e.g. "/ta/".
const BASE = new URL("./", self.location.href).pathname;
const BASE_NO_SLASH = BASE.length > 1 ? BASE.replace(/\/$/, "") : "/";

function absolute(path) {
  return new URL(path, self.location.origin + BASE).href;
}

// Cloudflare serves "x.html" at "x" and "index.html" at the directory, so
// store and look up pages under those canonical addresses.
function canonicalUrl(url) {
  const out = new URL(url);
  if (out.pathname.endsWith("/index.html")) {
    out.pathname = out.pathname.slice(0, -"index.html".length);
  } else if (out.pathname.endsWith(".html")) {
    out.pathname = out.pathname.slice(0, -".html".length);
  }
  out.search = "";
  out.hash = "";
  return out.href;
}

function isOurs(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname === BASE_NO_SLASH || url.pathname.startsWith(BASE)) &&
    !url.pathname.endsWith("/sw.js")
  );
}

function cacheable(response) {
  return response && response.ok && !response.redirected && response.type === "basic";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const path of PRECACHE) {
        try {
          const response = await fetch(absolute(path), { cache: "no-store" });
          if (cacheable(response)) {
            await cache.put(canonicalUrl(absolute(path)), response);
          }
        } catch (_error) {
          // A missing file is fetched again at runtime.
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function handleNavigation(request, url) {
  // A bare "/ta" visit: send the browser to "/ta/" so relative paths work.
  if (url.pathname === BASE_NO_SLASH && BASE_NO_SLASH !== BASE) {
    return Response.redirect(BASE + url.search, 302);
  }
  const cache = await caches.open(CACHE);
  const key = canonicalUrl(url.href);
  try {
    const response = await Promise.race([fetch(request), timeout(NAVIGATION_TIMEOUT_MS)]);
    if (cacheable(response)) {
      await cache.put(key, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await cache.match(key);
    if (cached) {
      return cached;
    }
    throw _error;
  }
}

async function handleAsset(request, url) {
  const cache = await caches.open(CACHE);
  const key = canonicalUrl(url.href);
  const cached = await cache.match(key);
  const network = fetch(request)
    .then(async (response) => {
      if (cacheable(response)) {
        await cache.put(key, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    return cached;
  }
  const response = await network;
  if (response) {
    return response;
  }
  return new Response("Offline and not cached", { status: 504 });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (!isOurs(url)) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, url));
    return;
  }
  event.respondWith(handleAsset(request, url));
});
