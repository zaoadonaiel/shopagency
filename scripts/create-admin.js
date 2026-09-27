// Usage: node scripts/create-admin.js "Your Name" you@email.com "a-strong-password"
// Creates the owner account in Supabase Auth and gives it role='admin' in profiles.
// The owner can also claim jobs, like any contractor. Running it again for the same email
// resets that account's password and makes it the owner.
require('dotenv').config();
const { sb, q } = require('../src/db');

const [name, rawEmail, password] = process.argv.slice(2);
if (!name || !rawEmail || !password || password.length < 8) {
  console.error('Usage: node scripts/create-admin.js "Name" email password(8+ chars)');
  process.exit(1);
}
const email = rawEmail.trim().toLowerCase();

(async () => {
  let id;
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (!error) {
    id = data.user.id;
  } else {
    const existing = await q(sb.from('profiles').select('id').eq('email', email).maybeSingle());
    if (!existing) throw new Error(error.message);
    id = existing.id;
    const { error: upErr } = await sb.auth.admin.updateUserById(id, { password, email_confirm: true });
    if (upErr) throw new Error(upErr.message);
  }
  await q(sb.from('profiles').upsert({ id, email, name, role: 'admin', active: true }, { onConflict: 'id' }));
  console.log('Owner account ready for', email);
})().catch((err) => { console.error('Could not create the owner:', err.message); process.exit(1); });
