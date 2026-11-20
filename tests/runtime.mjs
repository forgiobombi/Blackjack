import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

export const APP = 'http://localhost:5173'
export const TEST_CODE = '536781'
const clockModule = [
  "import production,{BlackjackTable as Table} from './index.js'",
  'export class BlackjackTable extends Table {',
  '  async fetch(request) {',
  "    if (new URL(request.url).pathname === '/__clock') {",
  '      const {elapsed, deadline, shoe} = await request.json()',
  '      await this.serial(async () => {',
  '        const state = await this.load()',
  '        if (elapsed !== undefined) state.current.lastActive = Date.now() - elapsed',
  '        if (deadline && state.current.round) state.current.round.deadline = Date.now() - 10',
  "        if (shoe) state.current.shoe = { cards: [...shoe,...Array(52-shoe.length).fill('2')].map((rank,id)=>({rank,id,suit:'S'})), cursor:0 }",
  '        await this.save(state)',
  '      })',
  '      await this.alarm()',
  "      return new Response('ok')",
  '    }',
  '    return super.fetch(request)',
  '  }',
  '}',
  'export default { ...production, fetch(request,env,ctx) {',
  '  const path = new URL(request.url).pathname',
  "  if (path.startsWith('/__clock/')) {",
  "    if (request.headers.get('X-Test-Key')!==env.TEST_KEY) return new Response(null,{status:403})",
  "    return env.TABLES.get(env.TABLES.idFromName(path.slice(9))).fetch('https://table.internal/__clock',{ method:'POST',body:request.body,duplex:'half' })",
  '  }',
  '  return production.fetch(request,env,ctx)',
  '} }',
].join('\n')

function mockAuth() {
  const users = new Map()
  const access = new Map()
  const refresh = new Map()
  function current(user) {
    const identity = {
      id: user.id,
      email: user.email,
      role: 'authenticated',
      aud: 'authenticated',
      email_confirmed_at: user.confirmed ? new Date().toISOString() : null,
      user_metadata: user.data,
    }
    return identity
  }
  function issue(user, session = crypto.randomUUID(), seconds = 3600) {
    const token =
      'fixture.' +
      Buffer.from(
        JSON.stringify({ session_id: session, exp: Math.floor(Date.now() / 1000) + seconds }),
      ).toString('base64url') +
      '.' +
      crypto.randomUUID()
    const key = 'refresh.' + crypto.randomUUID()
    access.set(token, { user, session })
    refresh.set(key, { user, session })
    return { access_token: token, refresh_token: key, user: current(user) }
  }
  function newUser(email, password, data, confirmed = false) {
    const user = { id: crypto.randomUUID(), email, password, data, confirmed }
    users.set(email, user)
    return user
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const data = raw.length ? JSON.parse(raw.toString()) : {}
    const bearer = request.headers.authorization?.slice(7)
    const send = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const fail = (code, status = 400) => send({ error_code: code }, status)
    if (url.pathname.endsWith('/signup')) {
      let user = users.get(data.email)
      if (!user) user = newUser(data.email, data.password, data.data)
      return send(current(user))
    }
    if (url.pathname.endsWith('/recover') || url.pathname.endsWith('/resend')) return send({})
    if (url.pathname.endsWith('/verify')) {
      const user = users.get(data.email)
      if (!user || data.token !== TEST_CODE) return fail('otp_expired')
      user.confirmed = true
      return send(issue(user))
    }
    if (url.pathname.endsWith('/token')) {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const old = refresh.get(data.refresh_token)
        if (!old) return fail('refresh_token_not_found')
        refresh.delete(data.refresh_token)
        return send(issue(old.user, old.session))
      }
      const user = users.get(data.email)
      if (!user || user.password !== data.password) return fail('invalid_credentials')
      if (!user.confirmed) return fail('email_not_confirmed')
      return send(issue(user))
    }
    if (url.pathname.endsWith('/logout')) {
      const entry = access.get(bearer)
      if (entry) {
        for (const [key, value] of refresh) if (value.session === entry.session) refresh.delete(key)
      }
      return send({})
    }
    if (url.pathname.endsWith('/user')) {
      const entry = access.get(bearer)
      if (!entry) return fail('bad_jwt', 401)
      if (request.method === 'PUT') entry.user.password = data.password
      return send(current(entry.user))
    }
    return fail('not_found', 404)
  })
  return { server, newUser, issue, users }
}

export async function fixture({ port = 0, browser = false } = {}) {
  const supabase = mockAuth()
  await new Promise((done) => supabase.server.listen(0, '127.0.0.1', done))
  const testKey = crypto.randomUUID()
  const storage = await mkdtemp(join(tmpdir(), 'blackjack-tests-'))
  const scriptPath = resolve('apps/worker/dist/index.js')
  const config = convertV4MiniflareOptions({
    host: '127.0.0.1',
    port,
    resourcePersistencePath: storage,
    compatibilityDate: '2026-11-20',
    name: 'blackjack-fixture',
    modules: [
      { type: 'ESModule', path: resolve('apps/worker/dist/test-clock.js'), contents: clockModule },
      { type: 'ESModule', path: scriptPath, contents: await readFile(scriptPath, 'utf8') },
    ],
    bindings: {
      APP_URL: APP + '/Blackjack/',
      SUPABASE_URL: 'https://supabase.fixture.test',
      SUPABASE_PUBLISHABLE_KEY: 'test-only-publishable-key',
      AUTH_BRIDGE_KEY: 'ab'.repeat(32),
      TEST_KEY: testKey,
    },
    outboundService: async (request) => {
      const target = new URL(request.url)
      if (target.hostname !== 'supabase.fixture.test') return new Response(null, { status: 502 })
      return fetch(
        'http://127.0.0.1:' + supabase.server.address().port + target.pathname + target.search,
        {
          method: request.method,
          headers: {
            authorization: request.headers.get('authorization') ?? '',
            'content-type': 'application/json',
          },
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
        },
      )
    },
    durableObjects: { TABLES: { className: 'BlackjackTable', useSQLite: true } },
    d1Databases: ['DB'],
    ratelimits: Object.fromEntries(
      ['API_LIMIT', 'AUTH_LIMIT', 'JOIN_LIMIT'].map((name, index) => [
        name,
        { namespace_id: String(100 + index), simple: { limit: 900, period: 60 } },
      ]),
    ),
  })
  let mf, base
  try {
    mf = new Miniflare(config)
    base = (await mf.ready).origin
    const migration = await readFile('apps/worker/migrations/0001_initial.sql', 'utf8')
    const statements = migration
      .trim()
      .split(/\n(?=CREATE (?:TABLE|INDEX|TRIGGER)|INSERT INTO system_settings)/)
      .map((sql) => sql.trim())
    const db = await mf.getD1Database('DB')
    await db.batch(statements.map((sql) => db.prepare(sql)))
  } catch (error) {
    await mf?.dispose()
    supabase.server.close()
    await rm(storage, { recursive: true, force: true })
    throw error
  }
  const auth = {}
  let calls = 0
  async function request(path, options = {}) {
    calls++
    const { user, body, method, origin = APP, headers } = options
    const response = await fetch(base + '/api' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(user ? { Authorization: 'Bearer ' + user.access } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, data }
  }
  async function newPlayer(name, role = 'player', expiry) {
    const user = supabase.newUser(
      name + '@example.test',
      'correct-horse-battery-123',
      { username: name, locale: 'en' },
      true,
    )
    const session = supabase.issue(user, undefined, expiry)
    const player = {
      id: user.id,
      access: session.access_token,
      refresh: session.refresh_token,
      password: user.password,
      email: user.email,
      name,
    }
    if (expiry === undefined || expiry > 0) {
      const result = await request('/me', { user: player })
      if (result.status !== 200) throw new Error('create player: ' + JSON.stringify(result))
      if (role !== 'player')
        await (
          await mf.getD1Database('DB')
        )
          .prepare('UPDATE profiles SET role=? WHERE id=?')
          .bind(role, user.id)
          .run()
    }
    auth[name] = player
    return player
  }
  return {
    mf,
    request,
    newPlayer,
    supabase,
    auth,
    get base() {
      return base
    },
    get calls() {
      return calls
    },
    db: () => mf.getD1Database('DB'),
    async changeClock(id, options) {
      const response = await fetch(base + '/__clock/' + id, {
        method: 'POST',
        headers: { 'X-Test-Key': testKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      })
      if (!response.ok)
        throw new Error('Test clock: ' + response.status + ' ' + (await response.text()))
    },
    async restart() {
      // A new workerd process rebuilds the object and D1 adapters from persistent SQLite files.
      await mf.setOptions(config)
      base = (await mf.ready).origin
    },
    async close() {
      await mf.dispose()
      await new Promise((done) => supabase.server.close(done))
      await rm(storage, { recursive: true, force: true })
    },
    ...(browser ? { browser: true } : {}),
  }
}
