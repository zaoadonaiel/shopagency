// End-to-end check of the whole flow against a real Supabase. Run: npm test
//
// Point it at a LOCAL Supabase (`supabase start`) or a DEDICATED test project, never production:
// it creates and deletes its own users and orders, and runs tick() over every order in the database.
// Settings come from .env.test if it exists, otherwise .env.
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const envFile = fs.existsSync(path.join(root, '.env.test')) ? '.env.test' : '.env';
require('dotenv').config({ path: path.join(root, envFile), quiet: true });
process.env.APP_URL = 'http://localhost:0';
for (const k of ['STRIPE_SECRET_KEY', 'SMTP_HOST', 'PROVISION_CMD', 'LOGIN_LINK_CMD', 'PROVISION_URL', 'LOGIN_LINK_URL']) delete process.env[k];

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(process.env.SUPABASE_URL || '');
if (!isLocal && process.env.SMOKE_TEST_REMOTE !== 'yes') {
  console.error(`SUPABASE_URL in ${envFile} is not a local Supabase. If it is a dedicated TEST project (not production), run:\n  SMOKE_TEST_REMOTE=yes npm test`);
  process.exit(1);
}

const assert = require('assert');
const { createClient } = require('@supabase/supabase-js');
const { sb, anonClient, q } = require('../src/db');
const jobs = require('../src/jobs');
const app = require('../src/server');

const log = console.log;
console.log = () => {}; // silence dev emails during the test

function client(base) {
  const jar = new Map();
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const k = pair.slice(0, pair.indexOf('=')).trim();
      const v = pair.slice(pair.indexOf('=') + 1);
      if (v) jar.set(k, v); else jar.delete(k);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), jar };
  };
}

const run = Date.now().toString(36);
const mail = (who) => `${who}-${run}@example.com`;
const PASSWORD = 'password123';
const created = [];
let packageId = null;

async function mkUser(email, name, role) {
  const { data, error } = await sb.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.push(data.user.id);
  await q(sb.from('profiles').insert({ id: data.user.id, email, name, role }));
  return data.user.id;
}

const orderIdFrom = (r) => Number((r.location.match(/\/dev\/pay\/(\d+)/) || [])[1]);
const getOrder = (id) => jobs.getOrder(id);
const ours = (rows) => rows.filter((r) => created.includes(r.contractor_id));

async function cleanup() {
  if (created.length) {
    const orders = await q(sb.from('orders').select('id').in('buyer_id', created));
    const ids = orders.map((o) => o.id);
    if (ids.length) {
      await q(sb.from('messages').delete().in('order_id', ids));
      await q(sb.from('exclusions').delete().in('order_id', ids));
      await q(sb.from('orders').delete().in('id', ids));
    }
  }
  if (packageId) await q(sb.from('packages').delete().eq('id', packageId));
  for (const id of created) await sb.auth.admin.deleteUser(id);
}

(async () => {
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  let failed = null;
  try {
    const ownerId = await mkUser(mail('owner'), 'Owner Person', 'admin');
    const habibi = await mkUser(mail('habibi'), 'Habibi Dev', 'contractor');
    const otobong = await mkUser(mail('otobong'), 'Otobong Dev', 'contractor');
    packageId = (await q(sb.from('packages').insert({ name: `Smoke test ${run}`, description: 'Test package', price_cents: 5000, contractor_pct: 40 }).select('id').single())).id;

    const buyer = client(base), c1 = client(base), c2 = client(base), boss = client(base);
    assert.equal((await c1('POST', '/login', { email: mail('habibi'), password: PASSWORD })).location, '/jobs');
    assert.equal((await c2('POST', '/login', { email: mail('otobong'), password: PASSWORD })).location, '/jobs');
    assert.equal((await boss('POST', '/login', { email: mail('owner'), password: PASSWORD })).location, '/admin');
    assert.match((await client(base)('POST', '/login', { email: mail('owner'), password: 'wrong-password' })).location, /Wrong%20email/);
    log('ok  Supabase Auth login: roles route to the right home, wrong password rejected');

    // Buyer signs up, orders, "pays" (dev mode)
    let r = await buyer('POST', '/signup', { name: 'Sarah Johnson', email: mail('sarah'), password: PASSWORD });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    assert.ok(r.jar.has('sb-access') && r.jar.has('sb-refresh'));
    const sarah = (await q(sb.from('profiles').select('id, role').eq('email', mail('sarah')).single()));
    created.push(sarah.id);
    assert.equal(sarah.role, 'buyer');
    assert.match((await client(base)('POST', '/signup', { name: 'Again', email: mail('sarah'), password: PASSWORD })).location, /already%20has%20an%20account/);
    r = await buyer('POST', `/order/${packageId}`, { business_name: 'Sarah Tacos', domain: 'sarahtacos.com', avada_code: 'abcd-1234', turnaround: '3d', notes: 'Five pages, red and yellow.' });
    const o1 = orderIdFrom(r);
    assert.ok(o1);
    await buyer('GET', `/dev/pay/${o1}`);
    let o = await getOrder(o1);
    assert.equal(o.status, 'open');
    assert.equal(o.card_fee_cents, 175); // 2.9% of $50 + 30 cents
    log('ok  buyer signed up (Supabase Auth), order created and paid -> open');

    // Two contractors claim at the same moment: exactly one wins
    const [a, b] = await Promise.all([c1('POST', `/jobs/${o1}/claim`), c2('POST', `/jobs/${o1}/claim`)]);
    o = await getOrder(o1);
    assert.equal(o.status, 'claimed');
    const winner = o.contractor_id, winnerClient = winner === habibi ? c1 : c2;
    const wins = [a, b].filter((x) => /You%20got%20it/.test(x.location || '')).length;
    assert.equal(wins, 1);
    assert.ok(o.site_url && o.wp_username);
    assert.equal(Math.round((new Date(o.due_at) - new Date(o.claimed_at)) / 36e5), 72);
    log('ok  claim lock: two-way race over HTTP, one winner, site provisioned, 72h deadline');

    // Hammer claim_order() directly: 20 simultaneous claims from two contractors, exactly one row comes back.
    const race = await q(sb.from('orders').insert({
      buyer_id: sarah.id, package_id: packageId, package_name: 'Race', status: 'open', price_cents: 5000, contractor_pct: 40,
      turnaround: '24h', turnaround_hours: 24, business_name: 'Race', avada_code: 'r', open_since: new Date().toISOString(),
    }).select('id').single());
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => q(sb.rpc('claim_order', { p_order_id: race.id, p_user_id: i % 2 ? habibi : otobong }))));
    assert.equal(results.reduce((n, rows) => n + rows.length, 0), 1);
    const raced = await getOrder(race.id);
    assert.equal(raced.status, 'claimed');
    assert.equal(Math.round((new Date(raced.due_at) - new Date(raced.claimed_at)) / 36e5), 24);
    log('ok  claim_order(): 20 simultaneous claims, exactly one winner');

    // Contractor cannot see the buyer's email; buyer message reaches the contractor
    await buyer('POST', `/orders/${o1}/message`, { body: 'Please add a menu page.' });
    const jobPage = await winnerClient('GET', `/jobs/${o1}`);
    assert.equal(jobPage.status, 200);
    assert.ok(!jobPage.text.includes(mail('sarah')));
    assert.ok(jobPage.text.includes('Sarah'));
    assert.ok(jobPage.text.includes('Please add a menu page.'));
    log('ok  messaging works and buyer email stays private');

    // Done -> ready -> buyer approves -> pay recorded
    await winnerClient('POST', `/jobs/${o1}/done`, { site_url: 'https://sarahtacos.com', pages_built: '5' });
    assert.equal((await getOrder(o1)).status, 'ready');
    assert.equal((await getOrder(o1)).contractor_pay_cents, 0); // nothing recorded before approval
    await buyer('POST', `/orders/${o1}/approve`);
    o = await getOrder(o1);
    assert.equal(o.status, 'approved');
    assert.equal(o.contractor_pay_cents, 2000);
    assert.equal(jobs.ownerNet(o), 2825);
    log('ok  approved: contractor $20.00, owner nets $28.25 after card fee');

    // Payout report and CSV
    const owed = ours(await jobs.payableByContractor());
    assert.equal(owed.length, 1);
    assert.equal(owed[0].owed_cents, 2000);
    const csv = await boss('GET', '/admin/payouts.csv');
    assert.match(csv.text, new RegExp(`"${o1}",.*"20\\.00"`));
    assert.match((await boss('GET', '/admin/payouts')).text, /\$20\.00/);
    await boss('POST', `/admin/payouts/${winner}/paid`);
    assert.equal(ours(await jobs.payableByContractor()).length, 0);
    assert.ok((await getOrder(o1)).paid_out_at);
    log('ok  weekly payout report, CSV and mark paid');

    // Missed deadline: reopen, exclude, cannot re-claim
    r = await buyer('POST', `/order/${packageId}`, { business_name: 'Sarah Tacos 2', avada_code: 'x-1', turnaround: '24h', notes: 'Second site.' });
    const o2 = orderIdFrom(r);
    await buyer('GET', `/dev/pay/${o2}`);
    await c1('POST', `/jobs/${o2}/claim`);
    assert.equal((await getOrder(o2)).contractor_id, habibi);
    await q(sb.from('orders').update({ claimed_at: new Date(Date.now() - 30 * 36e5).toISOString(), due_at: new Date(Date.now() - 6 * 36e5).toISOString() }).eq('id', o2));
    await jobs.tick();
    o = await getOrder(o2);
    assert.equal(o.status, 'open');
    assert.equal(o.contractor_id, null);
    r = await c1('POST', `/jobs/${o2}/claim`);
    assert.match(r.location, /cannot%20claim/);
    assert.equal((await getOrder(o2)).status, 'open');
    assert.equal((await q(sb.rpc('claim_order', { p_order_id: o2, p_user_id: habibi }))).length, 0); // the lock itself refuses too
    assert.ok(!(await c1('GET', '/jobs')).text.includes(`<td>${o2}</td>`));
    await c2('POST', `/jobs/${o2}/claim`);
    assert.equal((await getOrder(o2)).contractor_id, otobong);
    log('ok  missed deadline: reopened, excluded contractor blocked, another took it');

    // Reminders at 50% and 90% of the time
    await q(sb.from('orders').update({ claimed_at: new Date(Date.now() - 13 * 36e5).toISOString(), due_at: new Date(Date.now() + 11 * 36e5).toISOString() }).eq('id', o2));
    await jobs.tick();
    assert.equal((await getOrder(o2)).reminders_sent, 1);
    await q(sb.from('orders').update({ claimed_at: new Date(Date.now() - 22 * 36e5).toISOString(), due_at: new Date(Date.now() + 2 * 36e5).toISOString() }).eq('id', o2));
    await jobs.tick();
    assert.equal((await getOrder(o2)).reminders_sent, 2);
    assert.equal((await getOrder(o2)).status, 'claimed');
    log('ok  reminders at 50% and 90% of the deadline');

    // Dispute holds pay; refund works; permissions hold
    await c2('POST', `/jobs/${o2}/done`, { site_url: 'https://two.test', pages_built: '3' });
    await buyer('POST', `/orders/${o2}/dispute`, { reason: 'Colors are wrong' });
    assert.equal((await getOrder(o2)).dispute, true);
    assert.equal((await jobs.approve(o2)).ok, false);
    await jobs.setDispute(o2, false);
    assert.equal((await jobs.approve(o2)).ok, true);
    await jobs.setDispute(o2, true, 'Held by owner');
    assert.equal(ours(await jobs.payableByContractor()).length, 0);
    assert.ok((await jobs.heldOrders()).some((h) => h.id === o2 && h.contractor_name === 'Otobong Dev'));
    assert.equal((await jobs.refund(o2)).ok, true);
    o = await getOrder(o2);
    assert.equal(o.status, 'refunded');
    assert.equal(o.contractor_pay_cents, 0);
    assert.equal((await jobs.refund(o2)).ok, false);
    assert.equal((await jobs.refund(o1)).ok, false); // contractor already paid out
    log('ok  dispute holds pay (escrow), refund zeroes it');

    assert.equal((await c1('GET', '/admin')).status, 403);
    assert.equal((await buyer('GET', '/admin')).status, 403);
    assert.equal((await buyer('GET', '/jobs')).status, 403);
    assert.equal((await c1('GET', '/orders')).status, 403);
    assert.equal((await boss('GET', '/earnings')).status, 403);
    assert.match((await client(base)('GET', '/admin')).location, /^\/login\?next=/);
    assert.equal((await c1('GET', `/orders/${o1}`)).status, 403);
    assert.equal((await boss('GET', '/admin')).status, 200);
    log('ok  roles enforced (buyer, contractor, admin, logged out)');

    // Owner can claim and keeps everything
    r = await buyer('POST', `/order/${packageId}`, { business_name: 'Third', avada_code: 'y-1', turnaround: '3d', notes: 'Third.' });
    const o3 = orderIdFrom(r);
    await buyer('GET', `/dev/pay/${o3}`);
    await boss('POST', `/jobs/${o3}/claim`);
    await boss('POST', `/jobs/${o3}/done`, { site_url: 'https://three.test', pages_built: '5' });
    assert.equal((await jobs.approve(o3)).ok, true);
    assert.equal((await getOrder(o3)).contractor_pay_cents, 0);
    assert.ok(!(await jobs.payableByContractor()).some((p) => p.contractor_id === ownerId));
    log('ok  owner-claimed job: no contractor payout');

    // 48-hour auto-approve (and the 12-hour buyer reminder first)
    r = await buyer('POST', `/order/${packageId}`, { business_name: 'Fourth', avada_code: 'z-1', turnaround: '3d', notes: 'Fourth.' });
    const o4 = orderIdFrom(r);
    await buyer('GET', `/dev/pay/${o4}`);
    await c2('POST', `/jobs/${o4}/claim`);
    await c2('POST', `/jobs/${o4}/done`, { site_url: 'https://four.test', pages_built: '2' });
    o = await getOrder(o4);
    assert.equal(Math.round((new Date(o.auto_approve_at) - new Date(o.done_at)) / 36e5), 48);
    await q(sb.from('orders').update({ auto_approve_at: new Date(Date.now() + 6 * 36e5).toISOString() }).eq('id', o4));
    await jobs.tick();
    assert.equal((await getOrder(o4)).buyer_reminded, true);
    assert.equal((await getOrder(o4)).status, 'ready');
    await q(sb.from('orders').update({ auto_approve_at: new Date(Date.now() - 60e3).toISOString() }).eq('id', o4));
    await jobs.tick();
    o = await getOrder(o4);
    assert.equal(o.status, 'approved');
    assert.equal(o.contractor_pay_cents, 2000);
    log('ok  buyer reminded 12h before, auto-approved after 48h');

    // Unclaimed for 2 hours: alerted exactly once
    r = await buyer('POST', `/order/${packageId}`, { business_name: 'Fifth', avada_code: 'w-1', turnaround: '3d', notes: 'Fifth.' });
    const o5 = orderIdFrom(r);
    await buyer('GET', `/dev/pay/${o5}`);
    await q(sb.from('orders').update({ open_since: new Date(Date.now() - 3 * 36e5).toISOString() }).eq('id', o5));
    await jobs.tick();
    const alertedAt = (await getOrder(o5)).unclaimed_alerted_at;
    assert.ok(alertedAt);
    await jobs.tick();
    assert.equal((await getOrder(o5)).unclaimed_alerted_at, alertedAt);
    log('ok  unclaimed alert sent once');

    // Expired access token: the server refreshes it with the refresh token cookie
    const stale = client(base);
    await stale('POST', '/login', { email: mail('sarah'), password: PASSWORD });
    r = await stale('GET', '/orders');
    r.jar.set('sb-access', 'expired.or.garbage');
    r = await stale('GET', '/orders');
    assert.equal(r.status, 200);
    assert.ok(r.jar.get('sb-access') !== 'expired.or.garbage');
    log('ok  expired access token refreshed from the refresh cookie');

    // Forgot password: Supabase recovery link -> set a new password -> log in with it
    const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: 'recovery', email: mail('sarah') });
    if (linkErr) throw linkErr;
    const reset = client(base);
    r = await reset('GET', `/auth/confirm?token_hash=${link.properties.hashed_token}&type=recovery`);
    assert.equal(r.location, '/set-password');
    assert.equal((await reset('GET', '/set-password')).status, 200);
    r = await reset('POST', '/set-password', { password: 'newpassword456' });
    assert.equal(r.location, '/');
    assert.equal((await client(base)('POST', '/login', { email: mail('sarah'), password: 'newpassword456' })).location, '/');
    assert.match((await client(base)('POST', '/login', { email: mail('sarah'), password: PASSWORD })).location, /Wrong/);
    assert.equal((await client(base)('GET', `/auth/confirm?token_hash=${link.properties.hashed_token}&type=recovery`)).status, 410);
    // The default email templates hand the session to the browser in the URL #fragment; /auth/session takes it from there.
    const { data: s } = await anonClient().auth.signInWithPassword({ email: mail('habibi'), password: PASSWORD });
    r = await client(base)('POST', '/auth/session', { access_token: s.session.access_token, refresh_token: s.session.refresh_token, next: '/set-password' });
    assert.equal(r.location, '/set-password');
    assert.equal((await client(base)('POST', '/auth/session', { access_token: 'forged', refresh_token: 'x' })).status, 410);
    if (isLocal) {
      r = await client(base)('POST', '/forgot-password', { email: mail('sarah') });
      assert.match(r.location, /reset%20link/);
    }
    log('ok  forgot password: reset link, new password works, old one and reused link rejected');

    // Contractor invites (sends a real email, so only against local Supabase where it lands in Mailpit)
    if (isLocal) {
      r = await boss('POST', '/admin/contractors', { name: 'Invited Person', email: mail('invited') });
      assert.match(r.location, /Invite%20sent/);
      const inv = await q(sb.from('profiles').select('id, role').eq('email', mail('invited')).single());
      created.push(inv.id);
      assert.equal(inv.role, 'contractor');
      assert.match((await boss('POST', '/admin/contractors', { name: 'Again', email: mail('invited') })).location, /already%20has%20an%20account/);
      log('ok  contractor invite creates a contractor account (email in Mailpit)');
    } else {
      log('--  contractor invite email skipped (remote project: would send a real email)');
    }

    // Disabled contractor is logged out on the next request
    await boss('POST', `/admin/contractors/${habibi}/toggle`);
    assert.match((await c1('GET', '/jobs')).location, /^\/login/);
    assert.match((await client(base)('POST', '/login', { email: mail('habibi'), password: PASSWORD })).location, /Wrong/);
    await boss('POST', `/admin/contractors/${habibi}/toggle`);
    log('ok  disabled contractor cannot use the shop');

    // Second layer: with only the anon key and their own JWT, a user reads only their own rows and writes nothing
    const asUser = async (email, password) => {
      const { data } = await anonClient().auth.signInWithPassword({ email, password });
      return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      });
    };
    const asSarah = await asUser(mail('sarah'), 'newpassword456');
    const sarahOrders = await q(asSarah.from('orders').select('id, buyer_id'));
    assert.ok(sarahOrders.length >= 5 && sarahOrders.every((x) => x.buyer_id === sarah.id));
    assert.deepEqual((await q(asSarah.from('profiles').select('id'))).map((x) => x.id), [sarah.id]);
    const asOtobong = await asUser(mail('otobong'), PASSWORD);
    assert.deepEqual((await q(asOtobong.from('profiles').select('email'))).map((x) => x.email), [mail('otobong')]); // cannot read the buyer's email
    assert.ok((await q(asOtobong.from('orders').select('contractor_id'))).every((x) => x.contractor_id === otobong));
    assert.equal((await q(asOtobong.from('messages').select('id').eq('order_id', o1))).length, winner === otobong ? 1 : 0);
    const hack = await asOtobong.from('orders').update({ contractor_pay_cents: 999999 }).eq('id', o2).select();
    assert.ok(hack.error || hack.data.length === 0);
    assert.ok((await asOtobong.rpc('claim_order', { p_order_id: o5, p_user_id: otobong })).error);
    assert.ok((await asOtobong.from('profiles').update({ role: 'admin' }).eq('id', otobong).select()).error);
    const anonRead = await anonClient().from('orders').select('id');
    assert.ok(anonRead.error || anonRead.data.length === 0);
    assert.equal((await getOrder(o5)).status, 'open');
    log('ok  row level security: own rows only, no writes, no claim_order, nothing for anon');

    log('\nAll checks passed.');
  } catch (e) {
    failed = e;
  } finally {
    await cleanup().catch((e) => log('cleanup failed:', e.message));
    server.close();
  }
  if (failed) { log('FAILED:', failed); process.exit(1); }
  process.exit(0);
})();
