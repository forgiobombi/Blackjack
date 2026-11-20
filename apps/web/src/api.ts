import type { Locale } from '../../../packages/protocol/types.ts'

export const siteName = import.meta.env.VITE_SITE_NAME?.trim() || 'Blackjack Royale'
export const apiOrigin = (
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8787' : '')
).replace(/\/+$/, '')
const STORAGE = 'royale.session.v1'
const AUTH = 'royale.auth.request'

type Session = { access: string; refresh: string; expiry: number }

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code)
  }
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (!raw) return null
    const x = JSON.parse(raw)
    return typeof x.access === 'string' &&
      typeof x.refresh === 'string' &&
      typeof x.expiry === 'number'
      ? x
      : null
  } catch {
    return null
  }
}

function session(value: Session | null) {
  if (value) localStorage.setItem(STORAGE, JSON.stringify(value))
  else localStorage.removeItem(STORAGE)
  window.dispatchEvent(new Event('royale-session'))
}

async function raw<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  if (!apiOrigin) throw new ApiError('configuration', 503)
  let response: Response
  try {
    response = await fetch(apiOrigin + '/api' + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(12_000),
      headers: {
        ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError('unavailable')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw new ApiError(
      data?.error ?? (response.status === 429 ? 'rate_limit' : 'unavailable'),
      response.status,
    )
  return data as T
}

let refreshing: Promise<Session> | null = null

function renew(stale?: string): Promise<Session> {
  if (refreshing) return refreshing
  async function update() {
    const current = getSession()
    if (!current) throw new ApiError('auth_required', 401)
    if (current.expiry > Date.now() + 35_000 && current.access !== stale) return current
    try {
      const fresh = await raw<Session>('/auth/refresh', { body: { refresh: current.refresh } })
      if (getSession()?.refresh === current.refresh) session(fresh)
      return getSession() ?? fresh
    } catch (error) {
      const other = getSession()
      if (other && other.refresh !== current.refresh) return other
      if (error instanceof ApiError && error.status === 401) session(null)
      throw error
    }
  }
  refreshing = (
    navigator.locks ? navigator.locks.request('blackjack-royale-refresh', update) : update()
  ).finally(() => {
    refreshing = null
  })
  return refreshing
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const current = getSession()
  if (!current) throw new ApiError('auth_required', 401)
  const next = current.expiry <= Date.now() + 35_000 ? await renew(current.access) : current
  try {
    return await raw<T>(path, { ...options, token: next.access })
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    const fresh = await renew(next.access)
    return raw<T>(path, { ...options, token: fresh.access })
  }
}

function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export async function beginAuth(mode: 'login' | 'register', route: string, locale: Locale) {
  if (!apiOrigin) throw new ApiError('configuration', 503)
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  sessionStorage.setItem(AUTH, JSON.stringify({ verifier, route }))
  const url = new URL('/auth/' + mode, apiOrigin)
  url.searchParams.set('c', challenge)
  url.searchParams.set('lang', locale)
  location.assign(url.href)
}

export async function finishAuth(code: string) {
  const stored = sessionStorage.getItem(AUTH)
  if (!stored || !/^[\w-]{43}$/.test(code)) throw new ApiError('auth_exchange', 401)
  const parsed = JSON.parse(stored)
  const next = await raw<Session>('/auth/exchange', { body: { code, verifier: parsed.verifier } })
  session(next)
  sessionStorage.removeItem(AUTH)
  return typeof parsed.route === 'string' &&
    parsed.route.startsWith('/') &&
    !parsed.route.startsWith('/auth/')
    ? parsed.route
    : '/lobby'
}

export async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' })
  } finally {
    session(null)
  }
}

export function socketUrl(id: string) {
  const url = new URL('/api/tables/' + id + '/socket', apiOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export function inviteLink(token: string) {
  return location.origin + location.pathname + '#/join/' + token
}

export function codeOf(error: unknown) {
  return error instanceof ApiError ? error.code : 'unavailable'
}
