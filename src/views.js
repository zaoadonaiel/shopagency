// Tiny server-rendered UI. No build step, no framework.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same look as the main site (theagencyschool.com): colors, fonts and logo come from its src/styles/global.css.
const MAIN_SITE = (process.env.MAIN_SITE_URL || 'https://theagencyschool.com').replace(/\/$/, '');

const css = `
:root{
  --bg:#F5F8F7;--surface:#FFFFFF;--ink:#0A2A30;--muted:#4A6166;--line:#D3E0DF;
  --lagoon:#0F5C63;--lagoon-ink:#FFFFFF;--sun:#FFB72B;--sun-ink:#1B1300;--tint:#E4F0EE;
  --good:#1E7A4F;--good-bg:#DDF3E7;--warn:#9A6200;--warn-bg:#FFF0CC;--bad:#B3261E;--bad-bg:#FBE4E2;
  --display:'Bricolage Grotesque','Arial Narrow',Arial,sans-serif;
  --body:'Figtree',system-ui,-apple-system,'Segoe UI',sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#081A1E;--surface:#0F2A30;--ink:#E8F3F2;--muted:#9BB5B7;--line:#1E3E45;
  --lagoon:#4FB3B9;--lagoon-ink:#04191C;--tint:#123339;
  --good:#5FCB92;--good-bg:#0F3322;--warn:#F0B85A;--warn-bg:#3A2C0C;--bad:#F2867F;--bad-bg:#3A1513;color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#081A1E;--surface:#0F2A30;--ink:#E8F3F2;--muted:#9BB5B7;--line:#1E3E45;
  --lagoon:#4FB3B9;--lagoon-ink:#04191C;--tint:#123339;
  --good:#5FCB92;--good-bg:#0F3322;--warn:#F0B85A;--warn-bg:#3A2C0C;--bad:#F2867F;--bad-bg:#3A1513;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--body);padding-inline:16px}
.shell{max-width:1080px;margin-inline:auto}
a{color:var(--lagoon)}
h1,h2,h3{font-family:var(--display);letter-spacing:-.01em;line-height:1.1;text-wrap:balance}
h1{font-size:clamp(30px,4.6vw,44px);font-weight:800;margin:8px 0 22px}
h2{font-size:22px;font-weight:700;margin:30px 0 12px}
header.top{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between;padding-block:18px;border-bottom:1px solid var(--line)}
.logo{font:800 22px/1 var(--display);letter-spacing:-.01em;display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
.logo i{width:30px;height:30px;border-radius:8px;background:var(--lagoon) url("/icon-white.png") center/78% auto no-repeat;flex:none}
.logo small{font:600 12px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--lagoon);background:var(--tint);padding:5px 8px;border-radius:99px}
.nav{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:center}
.nav a{color:var(--ink);text-decoration:none;font-weight:500;padding:10px 2px;min-height:44px;display:inline-flex;align-items:center}
.nav a:hover,.nav a[aria-current="page"]{color:var(--lagoon);text-decoration:underline;text-underline-offset:4px}
.nav .btn{color:var(--sun-ink);text-decoration:none;padding:12px 18px}
main{padding-block:28px 64px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}
form.card:not(:has(.row)){max-width:600px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.grid .card{display:grid;gap:10px;align-content:start;margin:0}
.grid .card h2{font-size:24px;font-weight:800;margin:0}
.grid .card p{margin:0}.grid .card p:not(:has(b)){color:var(--muted)}
.grid .card b{font:800 34px/1 var(--display);font-variant-numeric:tabular-nums}
.grid .card .btn{justify-self:start;margin-top:6px}
label{display:block;font-weight:600;margin:14px 0 6px}
input,select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--surface);border:1.5px solid var(--line);border-radius:10px;padding:12px 14px}
input[type=checkbox]{width:auto;accent-color:var(--lagoon)}
button,.btn{display:inline-block;background:var(--sun);color:var(--sun-ink);font:700 16px/1 var(--display);padding:14px 20px;border-radius:10px;text-decoration:none;border:0;cursor:pointer}
button.alt,.btn.alt{background:transparent;color:var(--ink);border:1.5px solid var(--line)}
button.danger{background:var(--bad);color:#fff}
button:hover,.btn:hover{filter:brightness(1.06)}
button:focus-visible,.btn:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--lagoon);outline-offset:2px}
table{width:100%;border-collapse:collapse;font-size:15px;font-variant-numeric:tabular-nums}
th{font:600 12px/1.2 var(--body);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.wrap{overflow-x:auto}
.muted{color:var(--muted)}
.pill{display:inline-block;font:600 12px/1 var(--body);padding:5px 10px;border-radius:99px;background:var(--tint);color:var(--lagoon)}
.pill.pending_payment,.pill.cancelled{background:var(--tint);color:var(--muted)}
.pill.claimed{background:var(--warn-bg);color:var(--warn)}
.pill.ready,.pill.approved{background:var(--good-bg);color:var(--good)}
.pill.refunded,.pill.dispute{background:var(--bad-bg);color:var(--bad)}
.msg{padding:12px 14px;border-radius:12px;background:var(--tint);margin:8px 0}
.flash{padding:12px 16px;border-radius:12px;background:var(--tint);color:var(--ink);font-weight:500;margin-bottom:18px;border-left:4px solid var(--lagoon)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}form.inline{display:inline}
footer{border-top:1px solid var(--line);padding-block:24px 40px;color:var(--muted);font-size:13.5px;display:grid;gap:8px}
footer nav{display:flex;flex-wrap:wrap;gap:4px 18px}
footer a{color:var(--muted);padding:8px 0;display:inline-block}footer a:hover{color:var(--ink)}
@media (prefers-reduced-motion:no-preference){button,.btn{transition:filter .15s}}
`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&family=Figtree:wght@400;500;600&display=swap">';
const FAVICON = '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';

function layout({ title, user, flash, body, path = '' }) {
  const links = [];
  if (user) {
    if (user.role === 'buyer') links.push(['/', 'Order'], ['/orders', 'My orders']);
    if (user.role === 'contractor') links.push(['/jobs', 'Jobs'], ['/earnings', 'My earnings']);
    if (user.role === 'admin') links.push(['/jobs', 'Jobs'], ['/admin', 'Orders'], ['/admin/payouts', 'Payouts'], ['/admin/packages', 'Packages'], ['/admin/contractors', 'Contractors']);
  }
  const nav = links.map(([href, label]) => `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} | The Agency School Shop</title><meta name="theme-color" content="#0A2A30"><meta name="color-scheme" content="light dark">${FAVICON}${FONTS}<style>${css}</style></head><body>
<div class="shell"><header class="top"><a class="logo" href="/" aria-label="The Agency School Shop home"><i aria-hidden="true"></i>The Agency School <small>Shop</small></a><nav class="nav" aria-label="Main">${nav.join('')}${user
    ? `<form class="inline" method="post" action="/logout"><button class="alt" type="submit">Log out (${esc(user.name.split(' ')[0])})</button></form>`
    : '<a href="/login">Log in</a><a class="btn" href="/signup">Sign up</a>'}</nav></header>
<main id="main">${flash ? `<div class="flash" role="status">${esc(flash)}</div>` : ''}<h1>${esc(title)}</h1>${body}</main>
<footer><nav aria-label="Footer"><a href="${MAIN_SITE}/">theagencyschool.com</a><a href="${MAIN_SITE}/terms/">Terms of service</a><a href="${MAIN_SITE}/privacy-policy/">Privacy policy</a><a href="${MAIN_SITE}/refund-policy/">Refund policy</a><a href="${MAIN_SITE}/contact/">Contact</a></nav>
<span>&copy; ${new Date().getFullYear()} The Agency School. All rights reserved.</span></footer></div></body></html>`;
}

const statusLabel = { pending_payment: 'Awaiting payment', open: 'Queued', claimed: 'In progress', ready: 'Ready for review', approved: 'Approved', refunded: 'Refunded', cancelled: 'Cancelled' };
const pill = (o) => `<span class="pill ${esc(o.status)}">${esc(statusLabel[o.status] || o.status)}</span>${o.dispute ? ' <span class="pill dispute">Under review</span>' : ''}`;
const when = (iso) => (iso ? esc(new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })) : '');
// "2026-09-27 14:05:09" in UTC, the same message timestamp format the SQLite version showed.
const stamp = (ts) => (ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '');

function messagesBlock(order, messages, users, actionUrl) {
  const list = messages.map((m) => `<div class="msg"><b>${esc(users[m.sender_id] || 'Someone')}</b> <span class="muted">${esc(stamp(m.created_at))}</span><br>${esc(m.body).replace(/\n/g, '<br>')}</div>`).join('') || '<p class="muted">No messages yet.</p>';
  const form = ['claimed', 'ready', 'open'].includes(order.status)
    ? `<form method="post" action="${actionUrl}"><label for="body">Write a message</label><textarea id="body" name="body" rows="3" required></textarea><p><button type="submit">Send</button></p></form>` : '';
  return `<h2>Messages</h2>${list}${form}`;
}

module.exports = { esc, layout, pill, when, messagesBlock, statusLabel };
