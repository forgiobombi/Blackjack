import type { Env } from './env.ts'
import { Fault } from '../../../packages/protocol/validation.ts'

const COMMON = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(),microphone=(),geolocation=()',
}

export function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: COMMON })
}

export function html(payload: string, status = 200) {
  return new Response(payload, {
    status,
    headers: {
      ...COMMON,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
}

export function appUrl(env: Env): URL {
  if (!env.APP_URL) throw new Fault('configuration', 503)
  const url = new URL(env.APP_URL)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Fault('configuration', 503)
  return url
}

export function cors(response: Response, origin: string | null, env: Env) {
  if (response.status === 101 || !origin || !env.APP_URL) return response
  let expected: string
  try {
    expected = appUrl(env).origin
  } catch {
    return response
  }
  if (origin !== expected) return response
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  headers.set('Vary', 'Origin')
  return new Response(response.body, { status: response.status, headers })
}

export async function bodyText(request: Request, max = 12_288): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > max) throw new Fault('too_large', 413)
  if (!request.body) throw new Fault('invalid')
  const reader = request.body.getReader()
  const blocks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > max) {
      await reader.cancel()
      throw new Fault('too_large', 413)
    }
    blocks.push(value)
  }
  const raw = new Uint8Array(length)
  let offset = 0
  for (const block of blocks) {
    raw.set(block, offset)
    offset += block.byteLength
  }
  return new TextDecoder().decode(raw)
}

export async function bodyJson(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new Fault('invalid', 415)
  const payload = await bodyText(request)
  try {
    return JSON.parse(payload)
  } catch {
    throw new Fault('invalid')
  }
}

export async function limit(limiter: Env['API_LIMIT'], key: string) {
  if (!(await limiter.limit({ key })).success) throw new Fault('rate_limit', 429)
}

export function bearer(request: Request) {
  const parts = request.headers.get('Authorization')?.split(' ')
  if (parts?.length !== 2 || parts[0] !== 'Bearer' || parts[1].length > 8192)
    throw new Fault('auth_required', 401)
  return parts[1]
}

export function errorResponse(error: unknown) {
  if (error instanceof Fault) return json({ error: error.code }, error.status)
  // Avoid exception payloads that might include submitted content or a database binding.
  console.error('Internal request failure', error instanceof Error ? error.name : 'unknown')
  return json({ error: 'unavailable' }, 503)
}

export function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function unb64(value: string) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0),
  )
}

export async function digest(value: string) {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

export function token(bytes = 24) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)))
}
