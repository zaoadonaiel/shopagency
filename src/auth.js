// Logins are Supabase Auth. The browser holds the Supabase access and refresh tokens in two
// httpOnly, SameSite=Lax cookies. Every request verifies the access token with Supabase, refreshes
// it when it has expired, and loads req.user from `profiles` (role + active flag).
const { sb, anonClient, q } = require('./db');

const SESSION_DAYS = 14;
const ACCESS = 'sb-access';
const REFRESH = 'sb-refresh';
const secure = () => (process.env.APP_URL || '').startsWith('https');
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: secure(), path: '/' });

function setSessionCookies(res, session) {
  const opts = { ...cookieOpts(), maxAge: SESSION_DAYS * 864e5 };
  res.cookie(ACCESS, session.access_token, opts);
  res.cookie(REFRESH, session.refresh_token, opts);
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS, cookieOpts());
  res.clearCookie(REFRESH, cookieOpts());
}

// An active profile, or null. Disabled contractors have a profile with active=false.
async function activeProfile(authUser) {
  const p = await q(sb.from('profiles').select('*').eq('id', authUser.id).eq('active', true).maybeSingle());
  return p ? { ...p, email: authUser.email || p.email } : null;
}

// Email + password. Returns { user } with the profile, or { error }.
async function signIn(res, email, password) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) return { error: 'Wrong email or password.' };
  const user = await activeProfile(data.user);
  if (!user) {
    await sb.auth.admin.signOut(data.session.access_token, 'local').catch(() => {});
    return { error: 'Wrong email or password.' };
  }
  setSessionCookies(res, data.session);
  return { user };
}

// Tokens that came back from an email link (invite or password reset). Verified before use.
async function startSessionFromTokens(res, accessToken, refreshToken) {
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) return null;
  const user = await activeProfile(data.user);
  if (!user) return null;
  setSessionCookies(res, { access_token: accessToken, refresh_token: refreshToken });
  return user;
}

async function signOut(req, res) {
  const token = req.cookies && req.cookies[ACCESS];
  if (token) await sb.auth.admin.signOut(token, 'local').catch(() => {});
  clearSessionCookies(res);
}

// Loads req.user from the session cookies.
async function loadUser(req, res, next) {
  req.user = null;
  const access = req.cookies && req.cookies[ACCESS];
  const refresh = req.cookies && req.cookies[REFRESH];
  if (!access && !refresh) return next();
  try {
    let authUser = null;
    if (access) {
      const { data, error } = await sb.auth.getUser(access);
      if (!error) authUser = data.user;
    }
    if (!authUser && refresh) {
      const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refresh });
      if (!error && data.session) {
        setSessionCookies(res, data.session);
        authUser = data.user;
      }
    }
    if (authUser) req.user = await activeProfile(authUser);
    if (!req.user) clearSessionCookies(res);
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!roles.includes(req.user.role)) return res.status(403).send('Not allowed');
    next();
  };
}

module.exports = { signIn, signOut, startSessionFromTokens, setSessionCookies, loadUser, requireRole };
