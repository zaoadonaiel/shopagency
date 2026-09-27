// Tiny server-rendered UI. No build step, no framework.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const css = `
:root{--bg:#f4f7fa;--card:#fff;--ink:#22282f;--muted:#5b6570;--line:#d9e2eb;--blue:#2f6db0;--good:#1e7a4f;--warn:#9a6200;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#12161b;--card:#1a2027;--ink:#e8eef4;--muted:#9aa7b3;--line:#2b3540;--blue:#6fa8e8;--good:#5fcb92;--warn:#f0b85a;--bad:#f2867f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--blue)}header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1000px;margin:auto;padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;justify-content:space-between}
.bar nav{display:flex;flex-wrap:wrap;gap:6px 16px}.brand{font-weight:700;text-decoration:none;color:var(--ink)}
main{max-width:1000px;margin:auto;padding:24px 16px 60px}h1{font-size:26px;margin:0 0 16px}h2{font-size:19px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
label{display:block;font-weight:600;margin:12px 0 4px}input,select,textarea{width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button,.btn{display:inline-block;font:inherit;font-weight:600;background:var(--blue);color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;text-decoration:none}
button.alt,.btn.alt{background:transparent;color:var(--blue);border:1px solid var(--line)}button.danger{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.wrap{overflow-x:auto}.muted{color:var(--muted)}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;border:1px solid var(--line)}
.pill.open{color:var(--blue)}.pill.claimed{color:var(--warn)}.pill.ready,.pill.approved{color:var(--good)}.pill.refunded,.pill.dispute{color:var(--bad)}
.msg{padding:8px 12px;border-radius:8px;background:var(--bg);margin:6px 0}.flash{padding:10px 14px;border-radius:8px;background:var(--bg);border:1px solid var(--line);margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}form.inline{display:inline}
`;

function layout({ title, user, flash, body }) {
  const nav = [];
  if (user) {
    if (user.role === 'buyer') nav.push('<a href="/">Order</a>', '<a href="/orders">My orders</a>');
    if (user.role === 'contractor') nav.push('<a href="/jobs">Jobs</a>', '<a href="/earnings">My earnings</a>');
    if (user.role === 'admin') nav.push('<a href="/jobs">Jobs</a>', '<a href="/admin">Orders</a>', '<a href="/admin/payouts">Payouts</a>', '<a href="/admin/packages">Packages</a>', '<a href="/admin/contractors">Contractors</a>');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | The Agency School Shop</title><style>${css}</style></head><body>
<header><div class="bar"><a class="brand" href="/">The Agency School Shop</a><nav>${nav.join('')}${user
    ? `<form class="inline" method="post" action="/logout"><button class="alt" type="submit">Log out (${esc(user.name.split(' ')[0])})</button></form>`
    : '<a href="/login">Log in</a><a href="/signup">Sign up</a>'}</nav></div></header>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}<h1>${esc(title)}</h1>${body}</main></body></html>`;
}

const statusLabel = { pending_payment: 'Awaiting payment', open: 'Waiting for a contractor', claimed: 'In progress', ready: 'Ready for review', approved: 'Approved', refunded: 'Refunded', cancelled: 'Cancelled' };
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
