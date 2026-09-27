const { sb, q, isId } = require('./db');
const { sendMail } = require('./mail');
const { provisionSite, createLoginLink } = require('./provision');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const HOUR = 36e5;
const UNCLAIMED_ALERT_HOURS = Number(process.env.UNCLAIMED_ALERT_HOURS || 2);
const AUTO_APPROVE_HOURS = Number(process.env.AUTO_APPROVE_HOURS || 48);
const now = () => new Date().toISOString();
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

const money = (cents) => '$' + (cents / 100).toFixed(2);
const getOrder = async (id) => (isId(id) ? q(sb.from('orders').select('*').eq('id', id).maybeSingle()) : null);
const getUser = async (id) => (id ? q(sb.from('profiles').select('*').eq('id', id).maybeSingle()) : null);
const adminEmails = async () => (await q(sb.from('profiles').select('email').eq('role', 'admin').eq('active', true))).map((r) => r.email);

// Contractors (and the owner, who is also a contractor) who may claim this order.
async function eligibleClaimers(orderId) {
  const excluded = new Set((await q(sb.from('exclusions').select('contractor_id').eq('order_id', orderId))).map((e) => e.contractor_id));
  const users = await q(sb.from('profiles').select('id, email').in('role', ['contractor', 'admin']).eq('active', true));
  return users.filter((u) => !excluded.has(u.id)).map((u) => u.email);
}

// Stripe's US card fee is 2.9% + 30 cents. Overwritten with the real fee when Stripe reports it.
const estimateFee = (cents) => Math.round(cents * 0.029) + 30;

// Owner's net on an order after contractor pay and card fees.
function ownerNet(o) {
  return o.price_cents - o.contractor_pay_cents - o.card_fee_cents;
}

async function announceOpen(order, subjectPrefix = 'New job') {
  const to = await eligibleClaimers(order.id);
  await sendMail(to, `${subjectPrefix}: ${order.package_name} (${order.turnaround === '24h' ? '24 hours' : '1 to 3 business days'})`,
    `A job is open.\n\nPackage: ${order.package_name}\nBusiness: ${order.business_name}\nTurnaround: ${order.turnaround === '24h' ? '24 hours' : '1 to 3 business days'}\nYou earn: ${money(Math.round(order.price_cents * order.contractor_pct / 100))}\n\nThe first contractor to click Claim gets the job:\n${APP_URL()}/jobs/${order.id}\n`);
}

// Called after payment succeeds (Stripe webhook, or the dev "pay" button).
// The UPDATE only matches a pending order, so a retried webhook cannot announce the job twice.
async function markPaid(orderId, { paymentIntent = null, subscription = null, feeCents = null } = {}) {
  const o = await getOrder(orderId);
  if (!o || o.status !== 'pending_payment') return false;
  const t = now();
  const paid = { status: 'open', paid_at: t, open_since: t, stripe_payment_intent: paymentIntent, card_fee_cents: feeCents ?? estimateFee(o.price_cents) };
  if (subscription) paid.stripe_subscription_id = subscription;
  const rows = await q(sb.from('orders')
    .update(paid)
    .eq('id', orderId).eq('status', 'pending_payment').select());
  if (!rows.length) return false;
  await announceOpen(rows[0]);
  return true;
}

// The claim lock. One UPDATE inside the claim_order() Postgres function decides the winner,
// so two contractors can never both get the job.
async function claimJob(orderId, user) {
  if (!['contractor', 'admin'].includes(user.role)) return { ok: false, error: 'Only contractors can claim jobs.' };
  const o = await getOrder(orderId);
  if (!o) return { ok: false, error: 'Job not found.' };
  const excluded = await q(sb.from('exclusions').select('order_id').eq('order_id', orderId).eq('contractor_id', user.id).maybeSingle());
  if (excluded) return { ok: false, error: 'You cannot claim this job again.' };

  const won = await q(sb.rpc('claim_order', { p_order_id: orderId, p_user_id: user.id }));
  if (!won || won.length !== 1) return { ok: false, error: 'Already claimed.' };
  const dueAt = won[0].due_at;

  // Create the WordPress site on the owner's hosting. If it fails, the job stays claimed; the owner is alerted.
  try {
    const site = await provisionSite(won[0]);
    await q(sb.from('orders').update({ site_url: site.siteUrl, admin_url: site.adminUrl, wp_username: site.username }).eq('id', orderId));
  } catch (err) {
    console.error('Provisioning failed for order', orderId, err.message);
    await sendMail(await adminEmails(), `Provisioning failed for order #${orderId}`, `The site could not be created automatically.\n\n${err.message}\n\nOpen the order: ${APP_URL()}/admin/orders/${orderId}`);
  }

  const buyer = await getUser(o.buyer_id);
  await sendMail(buyer.email, `We are working on your ${o.package_name}`,
    `Good news, ${buyer.name}. ${user.name.split(' ')[0]} from our team is building your order now.\n\nDeadline: ${new Date(dueAt).toUTCString()}\nMessage us here: ${APP_URL()}/orders/${orderId}\n`);
  return { ok: true };
}

// Missed deadline or admin reassignment: back into the pool, and that contractor cannot take it again.
// The exclusion is written before the job reopens, so the late contractor can never re-claim it in between.
async function reopenAndExclude(orderId, reason) {
  const o = await getOrder(orderId);
  if (!o || o.status !== 'claimed') return false;
  await q(sb.from('exclusions').upsert({ order_id: orderId, contractor_id: o.contractor_id, reason }, { onConflict: 'order_id,contractor_id', ignoreDuplicates: true }));
  const rows = await q(sb.from('orders')
    .update({ status: 'open', contractor_id: null, claimed_at: null, due_at: null, reminders_sent: 0, open_since: now(), unclaimed_alerted_at: null })
    .eq('id', orderId).eq('status', 'claimed').eq('contractor_id', o.contractor_id).select());
  if (!rows.length) return false;
  const late = await getUser(o.contractor_id);
  await sendMail(await adminEmails(), `Order #${orderId} reopened: ${reason}`,
    `${late.name} was removed from order #${orderId} (${reason}) and cannot claim it again.\n\nSend the buyer your apology: ${APP_URL()}/admin/orders/${orderId}\n`);
  await sendMail(late.email, `Order #${orderId} was reassigned`, `The deadline passed, so the job went back to the pool. You cannot claim this job again.`);
  await announceOpen(rows[0], 'Reopened job');
  return true;
}

async function markDone(orderId, user, { siteUrl, pagesBuilt }) {
  const o = await getOrder(orderId);
  if (!o || o.status !== 'claimed' || o.contractor_id !== user.id) return { ok: false, error: 'Not your job.' };
  const pages = parseInt(pagesBuilt, 10);
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl) || !(pages > 0)) return { ok: false, error: 'Enter the site link and the number of pages built.' };

  const rows = await q(sb.from('orders')
    .update({ status: 'ready', done_at: now(), auto_approve_at: inHours(AUTO_APPROVE_HOURS), site_url: siteUrl, pages_built: pages, buyer_reminded: false })
    .eq('id', orderId).eq('status', 'claimed').eq('contractor_id', user.id).select());
  if (!rows.length) return { ok: false, error: 'Not your job.' };
  const fresh = rows[0];

  let loginUrl = '(message us on your order for a login link)';
  try { loginUrl = (await createLoginLink(fresh)).loginUrl; } catch (err) { console.error('Login link failed', err.message); }

  const buyer = await getUser(o.buyer_id);
  await sendMail(buyer.email, `Your website is ready: ${o.business_name}`,
    `Hi ${buyer.name},\n\nYour ${o.package_name} is ready.\n\nSite: ${siteUrl}\nPages built: ${pages}\nWordPress username: ${fresh.wp_username || ''}\nSet your WordPress password (one-time link, expires soon): ${loginUrl}\n\nPlease review it and approve it here. If you do nothing, it is approved automatically in ${AUTO_APPROVE_HOURS} hours:\n${APP_URL()}/orders/${orderId}\n`);
  return { ok: true };
}

// Approval records the contractor's pay. If the owner did the job himself he keeps everything (no payout row).
async function approve(orderId, { by = 'buyer' } = {}) {
  const o = await getOrder(orderId);
  if (!o || o.status !== 'ready') return { ok: false, error: 'This order cannot be approved right now.' };
  if (o.dispute) return { ok: false, error: 'This order is under review.' };
  const contractor = await getUser(o.contractor_id);
  const pay = contractor.role === 'admin' ? 0 : Math.round(o.price_cents * o.contractor_pct / 100);
  const rows = await q(sb.from('orders').update({ status: 'approved', approved_at: now(), contractor_pay_cents: pay })
    .eq('id', orderId).eq('status', 'ready').eq('dispute', false).select('id'));
  if (!rows.length) return { ok: false, error: 'This order cannot be approved right now.' };
  return { ok: true, by };
}

// A dispute freezes the contractor's pay (escrow) until the owner resolves it.
async function setDispute(orderId, on, reason = null) {
  await q(sb.from('orders').update({ dispute: !!on, hold_reason: on ? reason : null }).eq('id', orderId));
}

async function refund(orderId) {
  const o = await getOrder(orderId);
  if (!o || ['pending_payment', 'refunded', 'cancelled'].includes(o.status)) return { ok: false, error: 'Nothing to refund.' };
  if (o.paid_out_at) return { ok: false, error: 'The contractor was already paid for this order.' };
  if ((o.stripe_payment_intent || o.stripe_subscription_id) && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      // A monthly package: stop the subscription first so no later month is charged.
      if (o.stripe_subscription_id) {
        const sub = await stripe.subscriptions.retrieve(o.stripe_subscription_id);
        if (sub.status !== 'canceled') await stripe.subscriptions.cancel(o.stripe_subscription_id);
      }
      if (o.stripe_payment_intent) await stripe.refunds.create({ payment_intent: o.stripe_payment_intent });
    } catch (err) {
      return { ok: false, error: 'Stripe refund failed: ' + err.message };
    }
  }
  await q(sb.from('orders').update({ status: 'refunded', refunded_at: now(), contractor_pay_cents: 0, dispute: false, hold_reason: null }).eq('id', orderId));
  const buyer = await getUser(o.buyer_id);
  await sendMail(buyer.email, `Your refund for order #${orderId}`, `We refunded ${money(o.price_cents)} for ${o.package_name}. It can take a few days to appear on your card.`);
  return { ok: true };
}

async function addMessage(order, sender, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) return;
  await q(sb.from('messages').insert({ order_id: order.id, sender_id: sender.id, body: text }));
  const otherId = sender.id === order.buyer_id ? order.contractor_id : order.buyer_id;
  const other = otherId && await getUser(otherId);
  if (other) await sendMail(other.email, `New message on order #${order.id}`, `${sender.name.split(' ')[0]} wrote:\n\n${text}\n\nReply in the shop: ${APP_URL()}/${other.id === order.buyer_id ? 'orders' : 'jobs'}/${order.id}\n`);
}

// Runs every minute: reminders, missed deadlines, unclaimed alerts, auto-approval.
// Each step claims its work with a conditional UPDATE, so an overlapping run cannot send an email twice.
async function tick() {
  const t = now();

  // Unclaimed for too long: alert the owner and email every eligible contractor once.
  const unclaimed = await q(sb.from('orders').select('*').eq('status', 'open').is('unclaimed_alerted_at', null).lt('open_since', inHours(-UNCLAIMED_ALERT_HOURS)));
  for (const o of unclaimed) {
    const got = await q(sb.from('orders').update({ unclaimed_alerted_at: t }).eq('id', o.id).is('unclaimed_alerted_at', null).select('id'));
    if (!got.length) continue;
    await sendMail(await adminEmails(), `Nobody claimed order #${o.id}`, `Order #${o.id} (${o.package_name}) has been open for over ${UNCLAIMED_ALERT_HOURS} hours.\n${APP_URL()}/admin/orders/${o.id}`);
    await announceOpen(o, 'Still open');
  }

  // Claimed jobs: reminders at 50% and 90% of the time, then reopen after the deadline.
  for (const o of await q(sb.from('orders').select('*').eq('status', 'claimed').not('due_at', 'is', null))) {
    const total = new Date(o.due_at) - new Date(o.claimed_at);
    const used = Date.now() - new Date(o.claimed_at);
    if (used >= total) { await reopenAndExclude(o.id, 'missed deadline'); continue; }
    const c = await getUser(o.contractor_id);
    if (used >= total * 0.9 && o.reminders_sent < 2) {
      const got = await q(sb.from('orders').update({ reminders_sent: 2 }).eq('id', o.id).lt('reminders_sent', 2).select('id'));
      if (got.length) await sendMail(c.email, `Order #${o.id} is due very soon`, `90% of the time is gone. Deadline: ${new Date(o.due_at).toUTCString()}\n${APP_URL()}/jobs/${o.id}`);
    } else if (used >= total * 0.5 && o.reminders_sent < 1) {
      const got = await q(sb.from('orders').update({ reminders_sent: 1 }).eq('id', o.id).lt('reminders_sent', 1).select('id'));
      if (got.length) await sendMail(c.email, `Order #${o.id} is halfway to its deadline`, `Deadline: ${new Date(o.due_at).toUTCString()}\n${APP_URL()}/jobs/${o.id}`);
    }
  }

  // Ready orders: remind the buyer 12 hours before auto-approval, then auto-approve.
  for (const o of await q(sb.from('orders').select('*').eq('status', 'ready').eq('dispute', false))) {
    if (new Date(o.auto_approve_at) <= new Date(t)) { await approve(o.id, { by: 'auto' }); continue; }
    if (!o.buyer_reminded && new Date(o.auto_approve_at) <= new Date(inHours(12))) {
      const got = await q(sb.from('orders').update({ buyer_reminded: true }).eq('id', o.id).eq('buyer_reminded', false).select('id'));
      if (!got.length) continue;
      const buyer = await getUser(o.buyer_id);
      await sendMail(buyer.email, `Please approve your site (order #${o.id})`, `Your site will be approved automatically soon. Review it here:\n${APP_URL()}/orders/${o.id}`);
    }
  }
}

// Approved, not yet paid, not under dispute. Each row has the contractor's name and email attached.
async function payableOrders() {
  const rows = await q(sb.from('orders')
    .select('id, package_name, approved_at, contractor_id, contractor_pay_cents, contractor:profiles!orders_contractor_id_fkey(name, email)')
    .eq('status', 'approved').gt('contractor_pay_cents', 0).is('paid_out_at', null).eq('dispute', false));
  return rows.map(({ contractor, ...o }) => ({ ...o, name: contractor.name, email: contractor.email }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
}

// Weekly payout report: one row per contractor.
async function payableByContractor() {
  const byId = new Map();
  for (const o of await payableOrders()) {
    const r = byId.get(o.contractor_id) || { contractor_id: o.contractor_id, name: o.name, email: o.email, jobs: 0, owed_cents: 0 };
    r.jobs += 1;
    r.owed_cents += o.contractor_pay_cents;
    byId.set(o.contractor_id, r);
  }
  return [...byId.values()];
}

async function heldOrders() {
  const rows = await q(sb.from('orders').select('*, contractor:profiles!orders_contractor_id_fkey(name)').eq('dispute', true).order('id'));
  return rows.map(({ contractor, ...o }) => ({ ...o, contractor_name: contractor ? contractor.name : null }));
}

async function markContractorPaid(contractorId) {
  const rows = await q(sb.from('orders').update({ paid_out_at: now() })
    .eq('contractor_id', contractorId).eq('status', 'approved').gt('contractor_pay_cents', 0).is('paid_out_at', null).eq('dispute', false)
    .select('id'));
  return rows.length;
}

module.exports = {
  money, getOrder, getUser, adminEmails, ownerNet, estimateFee, markPaid, claimJob, reopenAndExclude, markDone, approve,
  setDispute, refund, addMessage, tick, payableOrders, payableByContractor, heldOrders, markContractorPaid, announceOpen,
};
