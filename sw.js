// WellDone Money service worker — v5.
// Deliberately minimal: NO offline caching of pages or data (financial
// dashboard). It exists only to (1) replace/delete every older cache so stale
// pre-auth shells can never be served, and (2) pass every request through to
// the network untouched.
//
// History: v3/v4 precached "/" and intercepted navigations. Once the auth gate
// started redirecting "/" to /login, that pattern broke twice: respondWith() of
// a redirected navigation response throws (falling back to the cached PRE-AUTH
// shell -> "unauthorized"), and precaching "/" failed install, so the stale
// worker kept control. See finance commit history / RENEWALS-INVENTORY.md.
const CACHE = "well-done-money-v5";

self.addEventListener("install", (event) => {
  self.skipWaiting(); // take control as soon as possible; no precache to fail
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("well-done-money-") && k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Never intercept navigations, API/auth routes, or non-GET requests.
  if (event.request.mode === "navigate") return;
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/login" || url.pathname === "/logout") {
    return;
  }
  // Network-only for everything else — a financial dashboard is never served
  // from cache, so logged-out users can never see cached balances offline.
  event.respondWith(fetch(event.request));
});
