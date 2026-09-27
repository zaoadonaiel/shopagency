// Creates the WordPress site on the OWNER's hosting. Hosting always stays with the owner.
//
// Two integration points. Each one returns ONE JSON object. If neither the command nor the URL is set,
// the app runs in dev mode and returns fake values.
//
//   PROVISION_CMD   called when a contractor claims a job. Args: <orderId> <businessName> <domainOrEmpty>
//                   must print: {"siteUrl":"...","adminUrl":"...","username":"..."}
//
//   LOGIN_LINK_CMD  called when the contractor marks the job done. Args: <orderId> <username>
//                   must print: {"loginUrl":"..."}   (a ONE-TIME link where the buyer sets their WordPress password)
//
// Cloudflare Workers cannot run shell commands, so there the same two hooks are HTTPS calls instead:
//
//   PROVISION_URL   POST {"orderId":"12","businessName":"...","domain":"..."}  -> same JSON as PROVISION_CMD
//   LOGIN_LINK_URL  POST {"orderId":"12","username":"..."}                      -> same JSON as LOGIN_LINK_CMD
//
// Both send "Authorization: Bearer <PROVISION_TOKEN>". scripts/provision-server.example.js is a tiny server
// for the hosting box that checks the token and runs the two shell scripts.
// See scripts/provision-wp.example.sh for a WP-CLI starting point.

function run(cmd, args) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error('Provisioning command did not print JSON: ' + stdout));
      }
    });
  });
}

async function call(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PROVISION_TOKEN || ''}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Provisioning endpoint returned ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Provisioning endpoint did not return JSON: ' + text.slice(0, 500));
  }
}

async function provisionSite(order) {
  if (process.env.PROVISION_URL) {
    return call(process.env.PROVISION_URL, { orderId: String(order.id), businessName: order.business_name, domain: order.domain || '' });
  }
  if (!process.env.PROVISION_CMD) {
    const slug = `order-${order.id}`;
    return { siteUrl: `https://${slug}.example-hosting.test`, adminUrl: `https://${slug}.example-hosting.test/wp-admin`, username: `client${order.id}` };
  }
  return run(process.env.PROVISION_CMD, [String(order.id), order.business_name, order.domain || '']);
}

async function createLoginLink(order) {
  if (process.env.LOGIN_LINK_URL) {
    return call(process.env.LOGIN_LINK_URL, { orderId: String(order.id), username: order.wp_username });
  }
  if (!process.env.LOGIN_LINK_CMD) {
    return { loginUrl: `${order.admin_url}/?dev-one-time-link=${order.id}` };
  }
  return run(process.env.LOGIN_LINK_CMD, [String(order.id), order.wp_username]);
}

module.exports = { provisionSite, createLoginLink };
