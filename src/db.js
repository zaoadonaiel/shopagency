// Supabase clients. The schema lives in supabase/migrations (run it with `supabase db push`).
//
// `sb` uses the SERVICE ROLE key: it bypasses row level security and can manage Auth users.
// It is used only inside this server. Never send the key to the browser.
//
// `anonClient()` makes a throwaway client with the anon key for calls made on behalf of one person
// (sign in, refresh, password reset email). A fresh one each time, because signing in on a shared
// client would make its later database calls run as that person instead of as the service role.
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  throw new Error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env');
}

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const sb = createClient(url, serviceKey, options);
const anonClient = () => createClient(url, anonKey, options);

// Awaits a query and returns its data, throwing on any database error.
async function q(query) {
  const { data, error } = await query;
  if (error) throw new Error(`Database error: ${error.message}`);
  return data;
}

// Route params are checked before they reach Postgres, so a bad id is a 404 and not a type error.
const isId = (v) => /^[1-9][0-9]{0,14}$/.test(String(v));
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

module.exports = { sb, anonClient, q, isId, isUuid };
