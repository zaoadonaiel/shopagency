require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { sb, anonClient, q, isId, isUuid } = require('./db');
const auth = require('./auth');
const jobs = require('./jobs');
const { sendMail } = require('./mail');
const { esc, layout, pill, when, messagesBlock } = require('./views');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { money } = jobs;

const app = express();
app.disable('x-powered-by');

// Stripe needs the raw body to verify the signature, so this route comes before the body parsers.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe is not configured');
  let event;
  try {
    // The async version also works on Cloudflare Workers, which verify with Web Crypto.
    event = await stripe.webhooks.constructEventAsync(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Bad signature');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const orderId = Number(s.metadata && s.metadata.order_id);
    let fee = null;
    try {
      const pi = await stripe.paymentIntents.retrieve(s.payment_intent, { expand: ['latest_charge.balance_transaction'] });
      fee = pi.latest_charge.balance_transaction.fee;
    } catch (err) { /* fall back to the estimate */ }
    if (orderId) await jobs.markPaid(orderId, { paymentIntent: s.payment_intent, feeCents: fee });
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(auth.loadUser);

const send = (req, res, title, body, status = 200) =>
  res.status(status).send(layout({ title, user: req.user, flash: req.query.msg, body, path: req.path }));
const back = (res, url, msg) => res.redirect(url + (msg ? (url.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : ''));
const home = (u) => (u.role === 'admin' ? '/admin' : u.role === 'contractor' ? '/jobs' : '/');
const isAdmin = (u) => u.role === 'admin';
const safeNext = (next, fallback) => (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : fallback);
const getPackage = async (id) => (isId(id) ? q(sb.from('packages').select('*').eq('id', id).eq('active', true).maybeSingle()) : null);
const messagesFor = (orderId) => q(sb.from('messages').select('*').eq('order_id', orderId).order('id'));
const emailTaken = (error) => error && (error.code === 'email_exists' || error.code === 'user_already_exists' || /already (been )?registered|already exists/i.test(error.message));

// Where Supabase sends people back to after an invite or password-reset email.
const EMAIL_LINK_REDIRECT = `${APP_URL}/auth/callback?next=/set-password`;

// Health check: says which settings are present (yes/no only, never the values) and whether the database answers.
app.get('/healthz', async (req, res) => {
  const has = (k) => !!(process.env[k] && process.env[k].trim());
  const out = { supabaseUrl: has('SUPABASE_URL'), anonKey: has('SUPABASE_ANON_KEY'), serviceRoleKey: has('SUPABASE_SERVICE_ROLE_KEY'), stripe: has('STRIPE_SECRET_KEY'), smtp: has('SMTP_HOST') };
  try {
    const { error } = await sb.from('packages').select('id').limit(1);
    out.database = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    out.database = `error: ${err.message}`;
  }
  res.status(out.database === 'ok' ? 200 : 503).json(out);
});

// ---------- Public: package menu ----------
app.get('/', async (req, res) => {
  if (req.user && req.user.role !== 'buyer') return res.redirect(home(req.user));
  const pk = await q(sb.from('packages').select('*').eq('active', true).order('price_cents'));
  send(req, res, 'Order a website', `<p class="muted">Pick a package. A contractor claims it, builds it on our hosting, and emails you when it is ready.</p>
  <div class="grid">${pk.map((p) => `<div class="card"><h2 style="margin-top:0">${esc(p.name)}</h2><p>${esc(p.description)}</p><p><b>${money(p.price_cents)}</b></p><a class="btn" href="/order/${p.id}">Order</a></div>`).join('')}</div>
  <p class="muted">You need your own Avada license (about $80, one time) and will enter its purchase code when you order.</p>`);
});

// ---------- Accounts (Supabase Auth) ----------
app.get('/signup', (req, res) => send(req, res, 'Create your account', `<form class="card" method="post" action="/signup">
  <label for="name">Name</label><input id="name" name="name" required><label for="email">Email</label><input id="email" type="email" name="email" required>
  <label for="password">Password (8+ characters)</label><input id="password" type="password" name="password" minlength="8" required><p><button type="submit">Sign up</button></p></form>`));

// Buyers sign up and are logged in straight away, as before. The account is created with the admin API
// (already confirmed), so the role is always 'buyer' and nobody can pick their own role.
app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) return back(res, '/signup', 'Enter your name, email and a password of 8+ characters.');
  const cleanEmail = email.trim().toLowerCase();
  const { data, error } = await sb.auth.admin.createUser({ email: cleanEmail, password, email_confirm: true, user_metadata: { name: name.trim() } });
  if (error) return back(res, '/signup', emailTaken(error) ? 'That email already has an account.' : error.message);
  const { error: pErr } = await sb.from('profiles').insert({ id: data.user.id, email: cleanEmail, name: name.trim(), role: 'buyer' });
  if (pErr) {
    await sb.auth.admin.deleteUser(data.user.id);
    return back(res, '/signup', 'That email already has an account.');
  }
  const r = await auth.signIn(res, cleanEmail, password);
  if (r.error) return back(res, '/login', r.error);
  res.redirect('/');
});

app.get('/login', (req, res) => send(req, res, 'Log in', `<form class="card" method="post" action="/login">
  <input type="hidden" name="next" value="${esc(req.query.next || '')}">
  <label for="email">Email</label><input id="email" type="email" name="email" required>
  <label for="password">Password</label><input id="password" type="password" name="password" required><p><button type="submit">Log in</button></p>
  <p class="muted"><a href="/forgot-password">Forgot your password?</a></p></form>`));

app.post('/login', async (req, res) => {
  const r = await auth.signIn(res, String(req.body.email || '').trim().toLowerCase(), String(req.body.password || ''));
  if (r.error) return back(res, '/login', r.error);
  res.redirect(safeNext(String(req.body.next || ''), home(r.user)));
});

app.post('/logout', async (req, res) => { await auth.signOut(req, res); res.redirect('/login'); });

// Forgot password: Supabase emails a one-time reset link that comes back to /auth/callback.
app.get('/forgot-password', (req, res) => send(req, res, 'Reset your password', `<form class="card" method="post" action="/forgot-password">
  <label for="email">Email</label><input id="email" type="email" name="email" required>
  <p class="muted">We will email you a one-time link to set a new password.</p><p><button type="submit">Send reset link</button></p></form>`));

app.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email) {
    const { error } = await anonClient().auth.resetPasswordForEmail(email, { redirectTo: EMAIL_LINK_REDIRECT });
    if (error) console.error('Password reset email failed:', error.message);
  }
  // Same answer either way, so the form does not reveal who has an account.
  back(res, '/login', 'If that email has an account, a reset link is on its way.');
});

// Email links (invite, password reset) land here. Two shapes are supported:
//  1. Supabase's default email templates put the session in the URL #fragment, which only the browser can
//     read, so a tiny script posts it to /auth/session.
//  2. Templates that link to /auth/confirm?token_hash=...&type=... (see README) are verified on the server.
app.get('/auth/callback', (req, res) => send(req, res, 'Signing you in', `<div class="card" id="status"><p>One moment...</p></div>
  <form id="f" method="post" action="/auth/session"><input type="hidden" name="access_token"><input type="hidden" name="refresh_token"><input type="hidden" name="next" value="${esc(req.query.next || '')}"></form>
  <script>
    var h = new URLSearchParams(location.hash.slice(1)), f = document.getElementById('f');
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('access_token') && h.get('refresh_token')) {
      f.access_token.value = h.get('access_token'); f.refresh_token.value = h.get('refresh_token'); f.submit();
    } else {
      document.getElementById('status').innerHTML = '<p>This link was already used or has expired. Ask the owner for a new one, or use <a href="/forgot-password">Forgot your password</a>.</p>';
    }
  </script>`));

app.post('/auth/session', async (req, res) => {
  const user = await auth.startSessionFromTokens(res, String(req.body.access_token || ''), String(req.body.refresh_token || ''));
  if (!user) return send(req, res, 'Link expired', '<p>This link was already used or has expired. Ask the owner for a new one.</p>', 410);
  res.redirect(safeNext(String(req.body.next || ''), home(user)));
});

app.get('/auth/confirm', async (req, res) => {
  const tokenHash = String(req.query.token_hash || '');
  const type = String(req.query.type || '');
  const expired = () => send(req, res, 'Link expired', '<p>This link was already used or has expired. Ask the owner for a new one.</p>', 410);
  if (!tokenHash || !['invite', 'recovery', 'magiclink', 'email'].includes(type)) return expired();
  const { data, error } = await anonClient().auth.verifyOtp({ token_hash: tokenHash, type });
  if (error || !data.session) return expired();
  const user = await auth.startSessionFromTokens(res, data.session.access_token, data.session.refresh_token);
  if (!user) return expired();
  const next = String(req.query.next || (['invite', 'recovery'].includes(type) ? '/set-password' : ''));
  res.redirect(safeNext(next, home(user)));
});

// Set a new password (after an invite or reset link has signed the person in).
app.get('/set-password', (req, res) => {
  if (!req.user) return send(req, res, 'Link expired', '<p>This link was already used or has expired. Ask the owner for a new one.</p>', 410);
  send(req, res, 'Set your password', `<form class="card" method="post" action="/set-password">
    <label for="password">New password (8+ characters)</label><input id="password" type="password" name="password" minlength="8" required><p><button type="submit">Save password</button></p></form>`);
});
app.post('/set-password', async (req, res) => {
  if (!req.user) return res.status(410).send('Link expired');
  const pw = String(req.body.password || '');
  if (pw.length < 8) return back(res, '/set-password', 'Use 8 or more characters.');
  const { error } = await sb.auth.admin.updateUserById(req.user.id, { password: pw });
  if (error) return back(res, '/set-password', error.message);
  res.redirect(home(req.user));
});

// ---------- Buyer: order + checkout ----------
app.get('/order/:pid', auth.requireRole('buyer'), async (req, res) => {
  const p = await getPackage(req.params.pid);
  if (!p) return res.status(404).send('Package not found');
  send(req, res, p.name, `<form class="card" method="post" action="/order/${p.id}">
    <p>${esc(p.description)}</p><p><b>${money(p.price_cents)}</b></p>
    <label for="business_name">Business name</label><input id="business_name" name="business_name" required>
    <label for="domain">Domain (if you have one)</label><input id="domain" name="domain" placeholder="example.com">
    <label for="avada_code">Avada license purchase code</label><input id="avada_code" name="avada_code" required>
    <label for="turnaround">Turnaround</label><select id="turnaround" name="turnaround"><option value="24h">24 hours</option><option value="3d" selected>1 to 3 business days</option></select>
    <label for="notes">What should the site say and look like? Logo, colors, page list, links to examples.</label><textarea id="notes" name="notes" rows="6" required></textarea>
    <p><button type="submit">Continue to payment</button></p></form>`);
});

app.post('/order/:pid', auth.requireRole('buyer'), async (req, res) => {
  const p = await getPackage(req.params.pid);
  const b = req.body;
  if (!p || !b.business_name || !b.avada_code || !b.notes) return back(res, `/order/${req.params.pid}`, 'Fill in every required field.');
  const turnaround = b.turnaround === '24h' ? '24h' : '3d';
  const row = await q(sb.from('orders').insert({
    buyer_id: req.user.id, package_id: p.id, package_name: p.name, price_cents: p.price_cents, contractor_pct: p.contractor_pct,
    turnaround, turnaround_hours: turnaround === '24h' ? 24 : 72,
    business_name: b.business_name.trim(), domain: (b.domain || '').trim(), avada_code: b.avada_code.trim(), notes: b.notes.trim(),
  }).select('id').single());
  const id = row.id;
  if (!stripe) return res.redirect(`/dev/pay/${id}`);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', customer_email: req.user.email, client_reference_id: String(id), metadata: { order_id: String(id) },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: p.price_cents, product_data: { name: p.name } } }],
    success_url: `${APP_URL}/orders/${id}?msg=${encodeURIComponent('Payment received. We are finding your contractor.')}`,
    cancel_url: `${APP_URL}/orders/${id}?msg=${encodeURIComponent('Payment was cancelled.')}`,
  });
  await q(sb.from('orders').update({ stripe_session_id: session.id }).eq('id', id));
  res.redirect(303, session.url);
});

// Dev mode only (no Stripe key): a fake pay button so the whole flow can be tested.
app.get('/dev/pay/:id', auth.requireRole('buyer'), async (req, res) => {
  if (stripe) return res.status(404).send('Not found');
  const o = await jobs.getOrder(req.params.id);
  if (!o || o.buyer_id !== req.user.id) return res.status(404).send('Not found');
  await jobs.markPaid(o.id);
  back(res, `/orders/${o.id}`, 'Dev mode: marked as paid.');
});

// ---------- Buyer: orders ----------
app.get('/orders', auth.requireRole('buyer'), async (req, res) => {
  const rows = await q(sb.from('orders').select('*').eq('buyer_id', req.user.id).order('id', { ascending: false }));
  send(req, res, 'My orders', `<div class="wrap card"><table><tr><th>#</th><th>Package</th><th>Business</th><th>Status</th><th>Price</th></tr>${rows.map((o) =>
    `<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${esc(o.package_name)}</td><td>${esc(o.business_name)}</td><td>${pill(o)}</td><td>${money(o.price_cents)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No orders yet.</td></tr>'}</table></div>`);
});

// Names only. Emails and phone numbers never leave this function.
async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const rows = await q(sb.from('profiles').select('id, name').in('id', unique));
  return Object.fromEntries(rows.map((u) => [u.id, u.name]));
}

app.get('/orders/:id', auth.requireRole('buyer'), async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o || o.buyer_id !== req.user.id) return res.status(404).send('Not found');
  const msgs = await messagesFor(o.id);
  const names = await usersById([...msgs.map((m) => m.sender_id), req.user.id, o.contractor_id]);
  const site = o.site_url && ['ready', 'approved'].includes(o.status)
    ? `<p>Site: <a href="${esc(o.site_url)}">${esc(o.site_url)}</a><br>Pages built: ${esc(o.pages_built)}<br>WordPress username: ${esc(o.wp_username)}<br><span class="muted">Your one-time password link was emailed to you.</span></p>` : '';
  const actions = o.status === 'ready' && !o.dispute
    ? `<form class="inline" method="post" action="/orders/${o.id}/approve"><button type="submit">Approve my site</button></form>
       <form method="post" action="/orders/${o.id}/dispute"><label for="reason">Something is wrong?</label><textarea id="reason" name="reason" rows="2" required></textarea><p><button class="alt" type="submit">Report a problem</button></p></form>` : '';
  send(req, res, `Order #${o.id}: ${o.package_name}`, `<div class="card"><p>${pill(o)}</p><p>${esc(o.business_name)} &middot; ${money(o.price_cents)}</p>
    ${o.due_at && o.status === 'claimed' ? `<p>Deadline: ${when(o.due_at)}</p>` : ''}${o.status === 'pending_payment' ? `<p><a class="btn" href="/order/${o.package_id}">Start over</a></p>` : ''}${site}${actions}</div>
    ${messagesBlock(o, msgs, names, `/orders/${o.id}/message`)}`);
});

app.post('/orders/:id/message', auth.requireRole('buyer'), async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o || o.buyer_id !== req.user.id) return res.status(404).send('Not found');
  await jobs.addMessage(o, req.user, req.body.body);
  res.redirect(`/orders/${o.id}`);
});
app.post('/orders/:id/approve', auth.requireRole('buyer'), async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o || o.buyer_id !== req.user.id) return res.status(404).send('Not found');
  const r = await jobs.approve(o.id);
  back(res, `/orders/${o.id}`, r.ok ? 'Thank you. Your order is approved.' : r.error);
});
app.post('/orders/:id/dispute', auth.requireRole('buyer'), async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o || o.buyer_id !== req.user.id || o.status !== 'ready') return res.status(404).send('Not found');
  await jobs.setDispute(o.id, true, String(req.body.reason || '').slice(0, 1000));
  const admins = await q(sb.from('profiles').select('email').eq('role', 'admin'));
  await sendMail(admins.map((r) => r.email), `Buyer reported a problem on order #${o.id}`,
    `${req.body.reason}\n\n${APP_URL}/admin/orders/${o.id}`);
  back(res, `/orders/${o.id}`, 'We received your report. The owner will contact you.');
});

// ---------- Contractors (the owner has a contractor login too, via the admin role) ----------
const claimers = auth.requireRole('contractor', 'admin');

app.get('/jobs', claimers, async (req, res) => {
  const excluded = new Set((await q(sb.from('exclusions').select('order_id').eq('contractor_id', req.user.id))).map((e) => e.order_id));
  const open = (await q(sb.from('orders').select('*').eq('status', 'open').order('open_since'))).filter((o) => !excluded.has(o.id));
  const mine = await q(sb.from('orders').select('*').eq('contractor_id', req.user.id).in('status', ['claimed', 'ready']).order('due_at'));
  const pay = (o) => (req.user.role === 'admin' ? 'You keep it' : money(Math.round(o.price_cents * o.contractor_pct / 100)));
  send(req, res, 'Jobs', `<h2>My active jobs</h2><div class="wrap card"><table><tr><th>#</th><th>Package</th><th>Status</th><th>Due</th></tr>${mine.map((o) =>
    `<tr><td><a href="/jobs/${o.id}">${o.id}</a></td><td>${esc(o.package_name)}</td><td>${pill(o)}</td><td>${when(o.due_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</table></div>
    <h2>Open jobs</h2><div class="wrap card"><table><tr><th>#</th><th>Package</th><th>Turnaround</th><th>You earn</th><th></th></tr>${open.map((o) =>
    `<tr><td>${o.id}</td><td>${esc(o.package_name)}</td><td>${o.turnaround === '24h' ? '24 hours' : '1 to 3 business days'}</td><td>${pay(o)}</td><td><a class="btn" href="/jobs/${o.id}">View</a></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No open jobs.</td></tr>'}</table></div>`);
});

app.get('/jobs/:id', claimers, async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o) return res.status(404).send('Not found');
  const mine = o.contractor_id === req.user.id;
  const pay = req.user.role === 'admin' ? 'You keep it' : money(Math.round(o.price_cents * o.contractor_pct / 100));
  if (!mine) {
    if (o.status !== 'open' && !isAdmin(req.user)) return back(res, '/jobs', 'That job was already claimed.');
    return send(req, res, `Job #${o.id}: ${o.package_name}`, `<div class="card"><p>${pill(o)}</p><p>Turnaround: ${o.turnaround === '24h' ? '24 hours' : '1 to 3 business days'}<br>You earn: <b>${pay}</b></p>
      ${o.status === 'open' ? `<form method="post" action="/jobs/${o.id}/claim"><button type="submit">Claim this job</button></form>` : ''}</div>`);
  }
  const msgs = await messagesFor(o.id);
  const names = await usersById([...msgs.map((m) => m.sender_id), o.buyer_id]);
  const buyerFirst = (names[o.buyer_id] || 'Buyer').split(' ')[0];
  const done = o.status === 'claimed' ? `<h2>Mark as done</h2><form class="card" method="post" action="/jobs/${o.id}/done">
    <label for="site_url">Site link</label><input id="site_url" name="site_url" value="${esc(o.site_url)}" placeholder="https://" required>
    <label for="pages_built">Pages built</label><input id="pages_built" type="number" min="1" name="pages_built" required>
    <p class="muted">The buyer gets an email with the site link, the page count and a one-time WordPress login link.</p><p><button type="submit">Mark done and email the buyer</button></p></form>` : '';
  send(req, res, `Job #${o.id}: ${o.package_name}`, `<div class="card"><p>${pill(o)} &nbsp; Due: <b>${when(o.due_at)}</b> &nbsp; You earn: <b>${pay}</b></p>
    <p><b>Buyer:</b> ${esc(buyerFirst)}<br><b>Business:</b> ${esc(o.business_name)}<br><b>Domain:</b> ${esc(o.domain) || 'none yet'}<br><b>Avada purchase code:</b> ${esc(o.avada_code)}</p>
    <p><b>Brief:</b><br>${esc(o.notes).replace(/\n/g, '<br>')}</p>
    <p><b>Site:</b> ${esc(o.site_url) || 'being created'}<br><b>WordPress admin:</b> ${esc(o.admin_url)}<br><b>Username:</b> ${esc(o.wp_username)}</p></div>
    ${done}${messagesBlock(o, msgs, names, `/jobs/${o.id}/message`)}`);
});

app.post('/jobs/:id/claim', claimers, async (req, res) => {
  const r = isId(req.params.id) ? await jobs.claimJob(Number(req.params.id), req.user) : { ok: false, error: 'Job not found.' };
  back(res, r.ok ? `/jobs/${req.params.id}` : '/jobs', r.ok ? 'You got it. The clock is running.' : r.error);
});
app.post('/jobs/:id/done', claimers, async (req, res) => {
  const r = isId(req.params.id)
    ? await jobs.markDone(Number(req.params.id), req.user, { siteUrl: req.body.site_url, pagesBuilt: req.body.pages_built })
    : { ok: false, error: 'Not your job.' };
  back(res, `/jobs/${req.params.id}`, r.ok ? 'Done. The buyer was emailed.' : r.error);
});
app.post('/jobs/:id/message', claimers, async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o || (o.contractor_id !== req.user.id && !isAdmin(req.user))) return res.status(404).send('Not found');
  await jobs.addMessage(o, req.user, req.body.body);
  res.redirect(`/jobs/${o.id}`);
});

app.get('/earnings', auth.requireRole('contractor'), async (req, res) => {
  const rows = await q(sb.from('orders').select('*').eq('contractor_id', req.user.id).in('status', ['approved', 'ready', 'claimed']).order('id', { ascending: false }));
  const owed = rows.filter((o) => o.status === 'approved' && !o.paid_out_at && !o.dispute).reduce((s, o) => s + o.contractor_pay_cents, 0);
  send(req, res, 'My earnings', `<div class="card"><p>Approved and not yet paid: <b>${money(owed)}</b>. Paid every week.</p></div>
    <div class="wrap card"><table><tr><th>#</th><th>Package</th><th>Status</th><th>Pay</th><th>Paid</th></tr>${rows.map((o) =>
    `<tr><td>${o.id}</td><td>${esc(o.package_name)}</td><td>${pill(o)}</td><td>${money(o.contractor_pay_cents || Math.round(o.price_cents * o.contractor_pct / 100))}</td><td>${o.paid_out_at ? when(o.paid_out_at) : o.dispute ? 'On hold' : ''}</td></tr>`).join('')}</table></div>`);
});

// ---------- Admin (the owner) ----------
const admin = auth.requireRole('admin');

app.get('/admin', admin, async (req, res) => {
  const rows = await q(sb.from('orders')
    .select('*, c:profiles!orders_contractor_id_fkey(name, role), b:profiles!orders_buyer_id_fkey(name)')
    .order('id', { ascending: false }).limit(200));
  send(req, res, 'All orders', `<div class="wrap card"><table><tr><th>#</th><th>Buyer</th><th>Package</th><th>Status</th><th>Contractor</th><th>Due</th><th>Price</th><th>My net</th></tr>${rows.map((o) => {
    const pay = o.status === 'approved' ? o.contractor_pay_cents : (o.c && o.c.role === 'admin' ? 0 : Math.round(o.price_cents * o.contractor_pct / 100));
    const net = o.status === 'pending_payment' || o.status === 'refunded' ? '' : money(o.price_cents - pay - o.card_fee_cents);
    return `<tr><td><a href="/admin/orders/${o.id}">${o.id}</a></td><td>${esc(o.b.name)}</td><td>${esc(o.package_name)}</td><td>${pill(o)}</td><td>${esc(o.c ? o.c.name : '')}</td><td>${when(o.due_at)}</td><td>${money(o.price_cents)}</td><td>${net}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No orders yet.</td></tr>'}</table></div>`);
});

app.get('/admin/orders/:id', admin, async (req, res) => {
  const o = await jobs.getOrder(req.params.id);
  if (!o) return res.status(404).send('Not found');
  const msgs = await messagesFor(o.id);
  const names = await usersById([...msgs.map((m) => m.sender_id), o.buyer_id, o.contractor_id]);
  const excl = (await q(sb.from('exclusions').select('reason, contractor:profiles!exclusions_contractor_id_fkey(name)').eq('order_id', o.id)))
    .map((e) => ({ name: e.contractor.name, reason: e.reason }));
  const buyer = await jobs.getUser(o.buyer_id);
  const btn = (action, label, cls = 'alt') => `<form class="inline" method="post" action="/admin/orders/${o.id}/${action}"><button class="${cls}" type="submit">${label}</button></form>`;
  send(req, res, `Order #${o.id}: ${o.package_name}`, `<div class="card"><p>${pill(o)} ${o.hold_reason ? `<span class="muted">Hold: ${esc(o.hold_reason)}</span>` : ''}</p>
    <p><b>Buyer:</b> ${esc(buyer.name)} (${esc(buyer.email)})<br><b>Business:</b> ${esc(o.business_name)} &middot; ${esc(o.domain)}<br><b>Avada code:</b> ${esc(o.avada_code)}<br>
    <b>Contractor:</b> ${esc(names[o.contractor_id] || 'none')}<br><b>Due:</b> ${when(o.due_at)}<br>
    <b>Price:</b> ${money(o.price_cents)} &middot; <b>Card fee:</b> ${money(o.card_fee_cents)} &middot; <b>Contractor share:</b> ${o.contractor_pct}%</p>
    <p><b>Brief:</b><br>${esc(o.notes).replace(/\n/g, '<br>')}</p>${excl.length ? `<p><b>Excluded:</b> ${excl.map((e) => esc(e.name + ' (' + e.reason + ')')).join(', ')}</p>` : ''}
    <div class="row">${o.status === 'claimed' ? btn('reassign', 'Take back and reopen') : ''}${o.dispute ? btn('resolve', 'Release hold') : btn('hold', 'Hold contractor pay')}${['open', 'claimed', 'ready', 'approved'].includes(o.status) ? btn('refund', 'Refund buyer', 'danger') : ''}</div></div>
    ${messagesBlock({ ...o, status: 'closed' }, msgs, names, '')}`);
});

// Admin order actions ignore ids that are not numbers, like the old version did.
const adminOrder = (fn) => async (req, res) => {
  if (!isId(req.params.id)) return back(res, `/admin/orders/${req.params.id}`);
  await fn(Number(req.params.id), req, res);
};
app.post('/admin/orders/:id/reassign', admin, adminOrder(async (id, req, res) => { await jobs.reopenAndExclude(id, 'reassigned by owner'); back(res, `/admin/orders/${id}`, 'Reopened.'); }));
app.post('/admin/orders/:id/hold', admin, adminOrder(async (id, req, res) => { await jobs.setDispute(id, true, 'Held by owner'); back(res, `/admin/orders/${id}`, 'Contractor pay is on hold.'); }));
app.post('/admin/orders/:id/resolve', admin, adminOrder(async (id, req, res) => { await jobs.setDispute(id, false); back(res, `/admin/orders/${id}`, 'Hold released.'); }));
app.post('/admin/orders/:id/refund', admin, adminOrder(async (id, req, res) => { const r = await jobs.refund(id); back(res, `/admin/orders/${id}`, r.ok ? 'Refunded.' : r.error); }));

app.get('/admin/payouts', admin, async (req, res) => {
  const owed = await jobs.payableByContractor();
  const held = await jobs.heldOrders();
  send(req, res, 'Weekly payouts', `<p class="muted">Approved jobs that are not paid out yet. Orders under dispute are held and left out.</p>
    <div class="wrap card"><table><tr><th>Contractor</th><th>Jobs</th><th>Owed</th><th></th></tr>${owed.map((r) =>
    `<tr><td>${esc(r.name)}<br><span class="muted">${esc(r.email)}</span></td><td>${r.jobs}</td><td><b>${money(r.owed_cents)}</b></td><td><form method="post" action="/admin/payouts/${r.contractor_id}/paid"><button type="submit">Mark paid</button></form></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing owed.</td></tr>'}</table></div>
    <p><a class="btn alt" href="/admin/payouts.csv">Download CSV</a></p>
    <h2>Held (escrow)</h2><div class="wrap card"><table><tr><th>#</th><th>Contractor</th><th>Reason</th></tr>${held.map((o) =>
    `<tr><td><a href="/admin/orders/${o.id}">${o.id}</a></td><td>${esc(o.contractor_name || '')}</td><td>${esc(o.hold_reason || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing on hold.</td></tr>'}</table></div>`);
});
app.post('/admin/payouts/:cid/paid', admin, async (req, res) => {
  const n = isUuid(req.params.cid) ? await jobs.markContractorPaid(req.params.cid) : 0;
  back(res, '/admin/payouts', `Marked ${n} job(s) as paid.`);
});
app.get('/admin/payouts.csv', admin, async (req, res) => {
  const rows = await jobs.payableOrders();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="payouts.csv"')
    .send(['order,contractor,email,package,approved_at,amount_usd', ...rows.map((r) => [r.id, r.name, r.email, r.package_name, new Date(r.approved_at).toISOString(), (r.contractor_pay_cents / 100).toFixed(2)].map(q).join(','))].join('\n'));
});

app.get('/admin/packages', admin, async (req, res) => {
  const pk = await q(sb.from('packages').select('*').order('id'));
  send(req, res, 'Packages', `${pk.map((p) => `<form class="card" method="post" action="/admin/packages/${p.id}"><div class="row">
    <input name="name" value="${esc(p.name)}" style="flex:2;min-width:200px"><input name="price" value="${(p.price_cents / 100).toFixed(2)}" style="flex:1;min-width:90px" aria-label="Price in dollars">
    <input name="pct" value="${p.contractor_pct}" style="flex:1;min-width:90px" aria-label="Contractor percent"><label style="margin:0"><input type="checkbox" name="active" ${p.active ? 'checked' : ''} style="width:auto"> Active</label>
    <button type="submit">Save</button></div><textarea name="description" rows="2" style="margin-top:8px">${esc(p.description)}</textarea></form>`).join('')}
    <h2>Add a package</h2><form class="card" method="post" action="/admin/packages"><input name="name" placeholder="Name" required><input name="price" placeholder="Price in dollars, like 50" required style="margin-top:8px">
    <input name="pct" value="40" style="margin-top:8px" aria-label="Contractor percent"><textarea name="description" rows="2" placeholder="Description" required style="margin-top:8px"></textarea><p><button type="submit">Add</button></p></form>
    <p class="muted">Price is in dollars. The percent is the contractor's share, currently 40% (you keep 60% before card fees). Changes apply to new orders only.</p>`);
});
const cents = (v) => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '')) * 100) || 0;
app.post('/admin/packages/:id', admin, async (req, res) => {
  if (isId(req.params.id)) {
    await q(sb.from('packages').update({
      name: req.body.name, description: req.body.description, price_cents: cents(req.body.price),
      contractor_pct: Math.min(100, Math.max(0, parseInt(req.body.pct, 10) || 0)), active: !!req.body.active,
    }).eq('id', req.params.id));
  }
  back(res, '/admin/packages', 'Saved.');
});
app.post('/admin/packages', admin, async (req, res) => {
  await q(sb.from('packages').insert({
    name: req.body.name, description: req.body.description, price_cents: cents(req.body.price),
    contractor_pct: Math.min(100, Math.max(0, parseInt(req.body.pct, 10) || 40)),
  }));
  back(res, '/admin/packages', 'Added.');
});

app.get('/admin/contractors', admin, async (req, res) => {
  const rows = await q(sb.from('profiles').select('*').eq('role', 'contractor').order('name'));
  send(req, res, 'Contractors', `<div class="wrap card"><table><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr>${rows.map((u) =>
    `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.active ? 'Active' : 'Disabled'}</td><td><form class="inline" method="post" action="/admin/contractors/${u.id}/toggle"><button class="alt" type="submit">${u.active ? 'Disable' : 'Enable'}</button></form></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No contractors yet.</td></tr>'}</table></div>
    <h2>Invite a contractor</h2><form class="card" method="post" action="/admin/contractors"><label for="name">Name</label><input id="name" name="name" required><label for="email">Email</label><input id="email" type="email" name="email" required>
    <p class="muted">They get an email with a one-time link to set their password. Collect a W-9 before their first payout.</p><p><button type="submit">Send invite</button></p></form>`);
});
// Supabase sends the invite email. The link signs them in and lands on /set-password.
app.post('/admin/contractors', admin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  if (!email || !name) return back(res, '/admin/contractors', 'Enter a name and email.');
  const { data, error } = await sb.auth.admin.inviteUserByEmail(email, { data: { name }, redirectTo: EMAIL_LINK_REDIRECT });
  if (error) return back(res, '/admin/contractors', emailTaken(error) ? 'That email already has an account.' : 'Invite failed: ' + error.message);
  const { error: pErr } = await sb.from('profiles').insert({ id: data.user.id, email, name, role: 'contractor' });
  if (pErr) {
    await sb.auth.admin.deleteUser(data.user.id);
    return back(res, '/admin/contractors', 'That email already has an account.');
  }
  back(res, '/admin/contractors', 'Invite sent.');
});
app.post('/admin/contractors/:id/toggle', admin, async (req, res) => {
  const u = isUuid(req.params.id) && await q(sb.from('profiles').select('id, active').eq('id', req.params.id).eq('role', 'contractor').maybeSingle());
  if (u) await q(sb.from('profiles').update({ active: !u.active }).eq('id', u.id).eq('role', 'contractor'));
  back(res, '/admin/contractors');
});

app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong.'); });

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Agency School Shop running on ${APP_URL} (port ${port}) ${stripe ? '' : '[DEV MODE: no Stripe key]'}`));
  setInterval(() => jobs.tick().catch((e) => console.error('tick failed', e)), 60 * 1000);
}

module.exports = app;
