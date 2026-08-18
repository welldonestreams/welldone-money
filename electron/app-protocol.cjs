// The app:// protocol handler.
//
// This replaces the loopback HTTP server the shell used to spawn. That server
// was the source of three separate problems: a port another process could
// already hold, a child process orphaned whenever the shell died without
// firing window-all-closed, and a health-nonce handshake invented to paper
// over the first two. Serving the bundle from a registered scheme removes all
// of them — there is no port, no child, and nothing else can answer.
//
// Deliberately dependency-free and free of any electron import, so the file
// serving and the security headers can be tested directly under node --test.
const { createReadStream, existsSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve, sep } = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'app';
// The scheme is registered as `standard`, so URLs carry a host. It is not a
// real network host and is never resolved; the bundle is always this one.
const HOST = 'bundle';
const ORIGIN = `${SCHEME}://${HOST}`;

// Mirrors nginx.conf. The two serving paths must not drift: a policy relaxed
// to chase a layout bug in one place has to fail the suite in both.
//
// connect-src is 'self', which is every origin this app currently talks to.
// When the hosted backend lands, its calls (auth, Plaid link and exchange,
// /api/finance/*) are cross-origin and this policy will block them with no
// console error worth reading. Add that one origin explicitly here and in
// nginx.conf — never a wildcard, and never by widening default-src.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; "
  + "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
  + "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// Requests the frontend makes to the hosted finance adapter (/api/...) have no
// answer inside the bundle. They resolve here and must 404 cleanly rather than
// throw, so the caller's own "bridge unreachable" path runs.
function createHandler(root) {
  const base = resolve(root);
  return function handle(request) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return notFound();
    }
    const candidate = normalize(join(base, pathname === '/' ? 'index.html' : pathname));
    // Containment: a resolved path must sit under the bundle root. Compared
    // with a trailing separator so a sibling directory sharing the prefix
    // (…/bundle-old) cannot pass a plain startsWith.
    //
    // NOTE (latent, not a live bug): this compares the lexical path only, so a
    // symlink inside the bundle pointing outside it would be followed by the
    // existsSync/statSync/createReadStream below. An asar archive holds no
    // symlinks and the repo has none, so it is not currently reachable. If it
    // ever becomes one, resolve with realpathSync(candidate) and re-check the
    // containment on the resolved path — after verifying realpathSync behaves
    // correctly on asar paths, since a wrong result would blank the app.
    if (candidate !== base && !candidate.startsWith(base + sep)) return notFound();
    if (!existsSync(candidate) || statSync(candidate).isDirectory()) return notFound();
    return new Response(Readable.toWeb(createReadStream(candidate)), {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': TYPES[extname(candidate)] || 'application/octet-stream',
      },
    });
  };
}

module.exports = { SCHEME, HOST, ORIGIN, CSP, SECURITY_HEADERS, createHandler };
