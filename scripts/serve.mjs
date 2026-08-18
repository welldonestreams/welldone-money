import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
// Marker the Electron shell checks on /__health to confirm it is talking to
// THIS server (and not some other process that grabbed the port).
const HEALTH_NONCE = 'welldone-money-ok';

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// Security headers mirroring nginx.conf so the desktop path (this server)
// carries the same CSP the suite verifies, not just the reverse-proxy path.
function securityHeaders(response) {
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Cache-Control', 'no-store');
}

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (path === '/__health') {
    securityHeaders(response);
    response.setHeader('Content-Type', 'text/plain');
    response.end(HEALTH_NONCE);
    return;
  }
  const candidate = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!candidate.startsWith(root) || !existsSync(candidate) || statSync(candidate).isDirectory()) {
    response.writeHead(404).end('Not found');
    return;
  }
  securityHeaders(response);
  response.setHeader('Content-Type', types[extname(candidate)] || 'application/octet-stream');
  createReadStream(candidate).pipe(response);
}).listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  // Single line on stdout so a parent process can read the assigned port
  // (pass PORT=0 to get an ephemeral one).
  console.log(`PORT=${actual}`);
  console.error(`Finance Hub available at http://127.0.0.1:${actual}`);
});
