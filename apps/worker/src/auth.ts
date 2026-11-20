import type { Env, Identity, Principal } from './env.ts'
import {
  appUrl,
  b64,
  bearer,
  bodyJson,
  bodyText,
  digest,
  escapeHtml,
  html,
  json,
  limit,
  token,
  unb64,
} from './http.ts'
import { Fault, object, string, username, uuid } from '../../../packages/protocol/validation.ts'
import { getProfile, registerProfile } from './wallet.ts'

type AuthUser = {
  id: string
  aud: string
  role: string
  is_anonymous?: boolean
  email?: string
  email_confirmed_at?: string
  user_metadata?: Record<string, unknown>
}
type Session = { access_token: string; refresh_token: string; expires_in?: number; user: AuthUser }
type ClientSession = { access: string; refresh: string; expiry: number }
const SHORT_CODE = /^[\w-]{43}$/

function jwtContext(token: string) {
  const payload = token.split('.')[1]
  try {
    const { session_id, exp } = JSON.parse(new TextDecoder().decode(unb64(payload)))
    const expiry = Number(exp) * 1000
    if (!Number.isSafeInteger(expiry) || expiry < Date.now()) throw new Error()
    return { session: uuid(session_id), expiry }
  } catch {
    throw new Fault('session_expired', 401)
  }
}

async function supabase<T>(
  env: Env,
  path: string,
  method: string,
  body?: unknown,
  access?: string,
): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new Fault('configuration', 503)
  let response: Response
  try {
    const url = new URL('/auth/v1/' + path, env.SUPABASE_URL)
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error()
    response = await fetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(7000),
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        ...(access ? { Authorization: 'Bearer ' + access } : {}),
        'Content-Type': 'application/json',
      },
    })
  } catch {
    throw new Fault('auth_unavailable', 503)
  }
  if (response.status === 204) return undefined as T
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (response.ok) return result as T
  if ((response.status >= 300 && response.status < 400) || response.status >= 500)
    throw new Fault('auth_unavailable', 503)
  if (response.status === 429) throw new Fault('email_rate', 429)
  const codes: Record<string, string> = {
    email_not_confirmed: 'verify_needed',
    invalid_credentials: 'invalid_credentials',
    weak_password: 'weak_password',
    otp_expired: 'otp_invalid',
    email_address_not_authorized: 'mail_unavailable',
    same_password: 'same_password',
    refresh_token_not_found: 'session_expired',
    refresh_token_already_used: 'session_expired',
  }
  throw new Fault(
    codes[String(result.error_code ?? result.code)] ??
      (path === 'user' ? 'session_expired' : 'auth_failed'),
    path === 'user' || path.includes('refresh_token') ? 401 : 400,
  )
}

function verified(user: AuthUser) {
  if (
    !user.email_confirmed_at ||
    !user.email ||
    user.aud !== 'authenticated' ||
    user.role !== 'authenticated' ||
    user.is_anonymous
  )
    throw new Fault('verify_needed', 403)
}

export async function identity(env: Env, request: Request): Promise<Identity> {
  const access = bearer(request)
  const context = jwtContext(access)
  const [user, revoked] = await Promise.all([
    supabase<AuthUser>(env, 'user', 'GET', undefined, access),
    env.DB.prepare('SELECT 1 AS present FROM revoked_sessions WHERE id=? AND expires_at>?')
      .bind(context.session, Date.now())
      .first(),
  ])
  if (revoked) throw new Fault('session_expired', 401)
  verified(user)
  return { id: uuid(user.id), ...context, metadata: user.user_metadata ?? {} }
}

export async function principal(env: Env, user: Identity): Promise<Principal> {
  const row = await getProfile(env.DB, user.id)
  if (!row) throw new Fault('profile_required', 409)
  if (row.suspended) throw new Fault('suspended', 403)
  return {
    id: user.id,
    session: user.session,
    expiry: user.expiry,
    role: row.role,
    name: row.display_name,
    avatar: row.avatar,
    balance: row.balance,
  }
}

export async function ensureProfile(env: Env, user: Identity, supplied?: unknown) {
  const current = await getProfile(env.DB, user.id)
  if (current) {
    if (current.suspended) throw new Fault('suspended', 403)
    return current
  }
  if (supplied === undefined && typeof user.metadata.username !== 'string')
    throw new Fault('profile_required', 409)
  return registerProfile(
    env.DB,
    user.id,
    username(supplied ?? user.metadata.username),
    user.metadata.locale === 'it' ? 'it' : 'en',
  )
}

function sessionPayload(session: Session): ClientSession {
  verified(session.user)
  if (typeof session.refresh_token !== 'string' || !session.refresh_token)
    throw new Fault('auth_failed', 400)
  return {
    access: session.access_token,
    refresh: session.refresh_token,
    expiry: jwtContext(session.access_token).expiry,
  }
}

async function bridgeKey(env: Env) {
  if (!/^[a-f0-9]{64}$/i.test(env.AUTH_BRIDGE_KEY ?? '')) throw new Fault('configuration', 503)
  const bytes = Uint8Array.from(env.AUTH_BRIDGE_KEY.match(/../g)!, (pair) =>
    Number.parseInt(pair, 16),
  )
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function authorize(env: Env, session: ClientSession, challenge: string) {
  const app = appUrl(env)
  const key = await bridgeKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const code = token(32)
  const id = await digest(code)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id + challenge) },
    key,
    new TextEncoder().encode(JSON.stringify(session)),
  )
  await env.DB.prepare('INSERT INTO auth_transfers VALUES(?,?,?,?)')
    .bind(id, challenge, b64(iv) + '.' + b64(new Uint8Array(cipher)), Date.now() + 120_000)
    .run()
  app.hash = '/auth/return/' + code
  return new Response(null, {
    status: 303,
    headers: { Location: app.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}

export async function exchange(env: Env, request: Request) {
  const data = object(await bodyJson(request))
  const code = string(data.code, 43, 43)
  const verifier = string(data.verifier, 43, 43)
  if (!SHORT_CODE.test(code) || !SHORT_CODE.test(verifier)) throw new Fault('auth_exchange', 401)
  const key = await bridgeKey(env)
  const [id, challenge] = await Promise.all([digest(code), digest(verifier)])
  const row = await env.DB.prepare(
    'DELETE FROM auth_transfers WHERE id=? AND challenge=? AND expires_at>? RETURNING payload',
  )
    .bind(id, challenge, Date.now())
    .first<{ payload: string }>()
  if (!row) throw new Fault('auth_exchange', 401)
  const [iv, ciphertext] = row.payload.split('.')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(id + challenge) },
    key,
    unb64(ciphertext),
  )
  return json(JSON.parse(new TextDecoder().decode(plaintext)))
}

export async function refresh(env: Env, request: Request) {
  const data = object(await bodyJson(request))
  const credentials = sessionPayload(
    await supabase<Session>(env, 'token?grant_type=refresh_token', 'POST', {
      refresh_token: string(data.refresh, 10, 1024),
    }),
  )
  const { session } = jwtContext(credentials.access)
  if (await env.DB.prepare('SELECT id FROM revoked_sessions WHERE id=?').bind(session).first())
    throw new Fault('session_expired', 401)
  return json(credentials)
}

export async function logout(env: Env, request: Request, user: Identity) {
  await env.DB.prepare(
    'INSERT INTO revoked_sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)',
  )
    .bind(user.session, Math.max(user.expiry, Date.now() + 86_400_000))
    .run()
  await supabase<void>(env, 'logout?scope=local', 'POST', undefined, bearer(request)).catch(
    () => {},
  )
  return json({ ok: true })
}

type Mode = 'login' | 'register' | 'forgot' | 'verify' | 'reset'
const MODES = ['login', 'register', 'forgot', 'verify', 'reset']
const COPY = {
  en: {
    login: 'Welcome back',
    register: 'Create your account',
    forgot: 'Recover your account',
    verify: 'Verify your email',
    reset: 'Set a new password',
    email: 'Email address',
    password: 'Password',
    confirm: 'Confirm password',
    username: 'Username',
    otp: 'Email verification code',
    loginLink: 'Sign in',
    registerLink: 'Create account',
    forgotLink: 'Forgot password?',
    verifyLink: 'Enter verification code',
    resetLink: 'Enter recovery code',
    lobby: 'Back to Blackjack Royale',
    submit: 'Continue',
    emailHint: 'Enter the code from your email.',
    accountSent: 'If the address can be verified, look for an email with your code.',
    recoverySent: 'If an account exists, look for an email with a recovery code.',
    mismatch: 'Enter matching passwords.',
    invalid: 'Check your details and try again.',
    invalid_username: 'Use 3–20 letters, numbers or underscores for the username.',
    verify_needed: 'Verify your email, then sign in.',
    invalid_credentials: 'The email or password is incorrect.',
    weak_password: 'Use a stronger password with at least 10 characters.',
    otp_invalid: 'The code is invalid or has expired.',
    mail_unavailable: 'Email delivery is unavailable. Contact the table host.',
    auth_unavailable: 'Authentication is temporarily unavailable.',
    email_rate: 'Too many attempts. Try again later.',
    rate_limit: 'Too many attempts. Try again later.',
    same_password: 'Choose a password different from your current one.',
    name: 'BLACKJACK ROYALE',
    auth_failed: 'Authentication failed. Check your details and try again.',
    configuration: 'Account access is awaiting setup.',
    exchange: 'Open account access from the Blackjack Royale lobby and try again.',
    resend: 'Resend verification email',
  },
  it: {
    login: 'Bentornato al tavolo',
    register: 'Crea il tuo account',
    forgot: 'Recupera il tuo account',
    verify: 'Verifica la tua email',
    reset: 'Scegli una nuova password',
    email: 'Indirizzo email',
    password: 'Password',
    confirm: 'Conferma password',
    username: 'Nome utente',
    otp: 'Codice ricevuto via email',
    loginLink: 'Accedi',
    registerLink: 'Crea account',
    forgotLink: 'Password dimenticata?',
    verifyLink: 'Inserisci il codice di verifica',
    resetLink: 'Inserisci il codice di recupero',
    lobby: 'Torna a Blackjack Royale',
    submit: 'Continua',
    emailHint: 'Inserisci il codice che hai ricevuto via email.',
    accountSent: 'Se l’indirizzo può essere verificato, troverai il codice nella tua posta.',
    recoverySent: 'Se esiste un account, riceverai un’email con il codice di recupero.',
    mismatch: 'Le password devono coincidere.',
    invalid: 'Controlla i dati e riprova.',
    invalid_username: 'Usa da 3 a 20 lettere, numeri o trattini bassi per il nome utente.',
    verify_needed: 'Verifica la tua email, poi accedi.',
    invalid_credentials: 'L’email o la password non è corretta.',
    weak_password: 'Scegli una password più sicura di almeno 10 caratteri.',
    otp_invalid: 'Il codice non è valido o è scaduto.',
    mail_unavailable: 'L’invio delle email non è disponibile. Contatta il gestore del tavolo.',
    auth_unavailable: 'L’accesso è temporaneamente indisponibile.',
    email_rate: 'Troppi tentativi. Riprova più tardi.',
    rate_limit: 'Troppi tentativi. Riprova più tardi.',
    same_password: 'Scegli una password diversa da quella attuale.',
    name: 'BLACKJACK ROYALE',
    auth_failed: 'Accesso non riuscito. Controlla i dati e riprova.',
    configuration: 'La configurazione dell’accesso deve essere completata.',
    exchange: 'Apri la pagina di accesso dalla sala di Blackjack Royale e riprova.',
    resend: 'Invia di nuovo l’email di verifica',
  },
}
const AUTH_CSS =
  'body{margin:0;min-height:100svh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 5%,#183f36,#0a1010 64%);color:#f1e5cc;font:16px system-ui;padding:1rem;box-sizing:border-box}main{width:min(100%,445px);box-sizing:border-box;background:#101b17;border:1px solid #3c4b3b;padding:clamp(22px,7vw,46px);border-radius:16px;box-shadow:0 20px 90px #0007}h1{font:400 clamp(29px,7vw,43px)/1.06 Georgia;margin:24px 0}.brand{color:#e2be7f;letter-spacing:.16em;font-size:12px;font-weight:700}label{display:grid;gap:7px;margin:14px 0}input,button{box-sizing:border-box;font:inherit;border-radius:7px;border:1px solid #596252;padding:11px 13px;min-height:46px;width:100%}input{color:#fff;background:#0b1511}input:focus,button:focus,a:focus{outline:2px solid #e7be7e;outline-offset:3px}button{margin:8px 0;color:#1d160b;background:#e2be7f;border:0;font-weight:700;cursor:pointer}a,.secondary{color:#e2be7f}nav{display:flex;gap:10px 14px;flex-wrap:wrap;margin-top:13px;font-size:14px}.alert{border-left:3px solid #d68f80;padding:9px 12px;background:#422d26}.note{color:#c1cbbf;font-size:14px}.secondary{background:transparent;border:1px solid #596252;font-size:14px}.back{display:inline-block;margin-top:26px;font-size:14px}'

function authPage(
  env: Env,
  mode: Mode,
  locale: 'en' | 'it',
  challenge: string,
  fields: {
    email?: string
    error?: string
    note?: 'accountSent' | 'recoverySent'
    status?: number
  } = {},
) {
  const t = COPY[locale]
  const q = '?lang=' + locale + '&amp;c=' + escapeHtml(challenge)
  const msg = fields.error
    ? '<p class="alert" role="alert">' +
      (t[fields.error as keyof typeof t] ?? t.auth_failed) +
      '</p>'
    : ''
  const note = fields.note ? '<p class="note" role="status">' + t[fields.note] + '</p>' : ''
  const email =
    '<label>' +
    t.email +
    '<input name="email" type="email" autocomplete="email" required maxlength="254" value="' +
    escapeHtml(fields.email ?? '') +
    '"></label>'
  const signup =
    mode === 'register'
      ? '<label>' +
        t.username +
        '<input name="username" autocomplete="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}"></label>'
      : ''
  const newPassword = mode === 'register' || mode === 'reset'
  const pass =
    mode === 'login' || newPassword
      ? '<label>' +
        t.password +
        '<input type="password" name="password" autocomplete="' +
        (newPassword ? 'new-password' : 'current-password') +
        '" required maxlength="128"' +
        (newPassword ? ' minlength="10"' : '') +
        '></label>'
      : ''
  const confirm = newPassword
    ? '<label>' +
      t.confirm +
      '<input type="password" name="confirm" autocomplete="new-password" required minlength="10" maxlength="128"></label>'
    : ''
  const otp =
    mode === 'verify' || mode === 'reset'
      ? '<label>' +
        t.otp +
        '<input name="otp" inputmode="numeric" pattern="[0-9]{6,10}" autocomplete="one-time-code" maxlength="10" required></label>'
      : ''
  const resend =
    mode === 'verify'
      ? '<button class="secondary" name="resend" value="1" formnovalidate>' + t.resend + '</button>'
      : ''
  const nav = [
    ['login', t.loginLink],
    ['register', t.registerLink],
    ['forgot', t.forgotLink],
    ['verify', t.verifyLink],
    ['reset', t.resetLink],
  ]
    .filter(([path]) => path !== mode)
    .map(([path, text]) => '<a href="/auth/' + path + q + '">' + text + '</a>')
    .join('')
  const form = SHORT_CODE.test(challenge)
    ? '<form method="post" action="/auth/' +
      mode +
      q +
      '">' +
      email +
      signup +
      otp +
      pass +
      confirm +
      '<button>' +
      t.submit +
      '</button>' +
      resend +
      '</form><nav>' +
      nav +
      '</nav>'
    : '<p class="note">' + t.exchange + '</p>'
  const back = env.APP_URL ? escapeHtml(appUrl(env).href) : '/'
  return html(
    '<!doctype html><html lang="' +
      locale +
      '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      t[mode] +
      ' · Blackjack Royale</title><style>' +
      AUTH_CSS +
      '</style><main><div class="brand">♠ ' +
      t.name +
      '</div><h1>' +
      t[mode] +
      '</h1>' +
      msg +
      note +
      form +
      '<a class="back" href="' +
      back +
      '">' +
      t.lobby +
      '</a></main></html>',
    fields.status,
  )
}

export async function handleAuthPage(env: Env, request: Request, url: URL) {
  const mode = url.pathname.slice('/auth/'.length) as Mode
  if (!MODES.includes(mode)) throw new Fault('not_found', 404)
  const locale = url.searchParams.get('lang') === 'it' ? 'it' : 'en'
  const candidate = url.searchParams.get('c') ?? ''
  const challenge = SHORT_CODE.test(candidate) ? candidate : ''
  if (request.method === 'GET') return authPage(env, mode, locale, challenge)
  if (request.method !== 'POST' || !challenge || request.headers.get('Origin') !== url.origin)
    throw new Fault('origin', 403)
  let email = ''
  try {
    await limit(env.AUTH_LIMIT, 'form:' + (request.headers.get('CF-Connecting-IP') ?? 'local'))
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
      throw new Fault('invalid', 415)
    const fields = new URLSearchParams(await bodyText(request, 4096))
    email = string(fields.get('email'), 3, 254).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Fault('invalid')
    await limit(env.AUTH_LIMIT, 'address:' + (await digest(email)))
    const password = fields.get('password') ?? ''
    if (mode === 'register' || mode === 'reset') {
      if (password !== fields.get('confirm')) throw new Fault('mismatch')
      if (password.length < 10 || password.length > 128) throw new Fault('weak_password')
    }
    if (mode === 'register') {
      await supabase(env, 'signup', 'POST', {
        email,
        password,
        data: { username: username(fields.get('username')), locale },
      })
      return authPage(env, 'verify', locale, challenge, { email, note: 'accountSent' })
    }
    if (mode === 'forgot') {
      await supabase(env, 'recover', 'POST', { email })
      return authPage(env, 'reset', locale, challenge, { email, note: 'recoverySent' })
    }
    if (mode === 'verify' && fields.get('resend') === '1') {
      await supabase(env, 'resend', 'POST', { email, type: 'signup' })
      return authPage(env, 'verify', locale, challenge, { email, note: 'accountSent' })
    }
    if (mode === 'login') {
      if (!password || password.length > 128) throw new Fault('invalid')
      const session = await supabase<Session>(env, 'token?grant_type=password', 'POST', {
        email,
        password,
      })
      return await authorize(env, sessionPayload(session), challenge)
    }
    const otp = fields.get('otp') ?? ''
    if (!/^\d{6,10}$/.test(otp)) throw new Fault('otp_invalid')
    const session = await supabase<Session>(env, 'verify', 'POST', {
      email,
      token: otp,
      type: mode === 'reset' ? 'recovery' : 'email',
    })
    const credentials = sessionPayload(session)
    if (mode === 'reset') await supabase(env, 'user', 'PUT', { password }, credentials.access)
    return await authorize(env, credentials, challenge)
  } catch (error) {
    return authPage(env, mode, locale, challenge, {
      email,
      error: error instanceof Fault ? error.code : 'auth_unavailable',
      status: error instanceof Fault ? error.status : 503,
    })
  }
}
