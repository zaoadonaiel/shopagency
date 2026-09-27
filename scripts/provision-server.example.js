// EXAMPLE ONLY. Runs on the WordPress hosting box when the shop is on Cloudflare Workers
// (Workers cannot run shell commands). It receives the shop's two provisioning calls and runs the
// same two shell scripts that PROVISION_CMD / LOGIN_LINK_CMD would run.
//
//   PROVISION_TOKEN=<long random string> \
//   PROVISION_SCRIPT=/opt/shop/provision-wp.sh LOGIN_LINK_SCRIPT=/opt/shop/wp-login-link.sh \
//   STAGING_DOMAIN=staging.example.com PORT=8787 node provision-server.example.js
//
// Put it behind HTTPS (nginx, Caddy or a Cloudflare Tunnel), then set in the shop:
//   PROVISION_URL=https://<this host>/provision   LOGIN_LINK_URL=https://<this host>/login-link   PROVISION_TOKEN=<same string>
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const token = process.env.PROVISION_TOKEN;
if (!token || token.length < 32) throw new Error('Set PROVISION_TOKEN to a random string of 32+ characters');

const routes = {
  '/provision': (b) => [process.env.PROVISION_SCRIPT, [String(b.orderId), String(b.businessName || ''), String(b.domain || '')]],
  '/login-link': (b) => [process.env.LOGIN_LINK_SCRIPT, [String(b.orderId), String(b.username || '')]],
};

const authorized = (req) => {
  const given = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

http.createServer((req, res) => {
  const route = routes[req.url];
  if (req.method !== 'POST' || !route) { res.writeHead(404).end(); return; }
  if (!authorized(req)) { res.writeHead(401).end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch (e) { res.writeHead(400).end('bad json'); return; }
    if (!/^[0-9]+$/.test(String(body.orderId))) { res.writeHead(400).end('bad orderId'); return; }
    const [cmd, args] = route(body);
    execFile(cmd, args, { timeout: 120000 }, (err, stdout) => {
      if (err) { res.writeHead(500).end(err.message); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(stdout.trim().split('\n').pop());
    });
  });
}).listen(Number(process.env.PORT || 8787));
