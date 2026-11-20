import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { APP } from './runtime.mjs'
import { DEFAULT_TABLE } from '../packages/protocol/rules.ts'

export function config(overrides = {}) {
  return {
    ...DEFAULT_TABLE,
    name: 'Golden Room',
    description: 'Friday table',
    bettingSeconds: 8,
    turnSeconds: 10,
    ...overrides,
    rules: { ...DEFAULT_TABLE.rules, insurance: false, ...overrides.rules },
  }
}

export async function table(runtime, user, input = {}) {
  const id = crypto.randomUUID()
  const result = await runtime.request('/tables', { user, body: { id, settings: config(input) } })
  assert.equal(result.status, 201, JSON.stringify(result))
  return id
}
export async function host(runtime, user, id, action, extra = {}) {
  const result = await runtime.request('/tables/' + id + '/admin', {
    user,
    body: { id: crypto.randomUUID(), action, ...extra },
  })
  assert.equal(result.status, 200, JSON.stringify(result))
  return result.data
}
export async function makeInvite(runtime, owner, id, extra = {}) {
  const result = await runtime.request('/tables/' + id + '/invite', {
    user: owner,
    body: { uses: 10, minutes: 120, ...extra },
  })
  assert.equal(result.status, 201, JSON.stringify(result))
  return result.data
}
export async function join(runtime, user, invite) {
  const result = await runtime.request('/join', { user, body: { invite } })
  assert.equal(result.status, 200, JSON.stringify(result))
  return result.data.table.id
}

export async function connect(runtime, user, id) {
  const result = await runtime.request('/tables/' + id + '/ticket', { user, method: 'POST' })
  assert.equal(result.status, 200, JSON.stringify(result))
  const ws = new WebSocket(
    runtime.base.replace(/^http/, 'ws') + '/api/tables/' + id + '/socket',
    ['royale.v1', 'ticket.' + result.data.ticket],
    { origin: APP },
  )
  const frames = []
  const replies = new Map()
  let latest
  let count = 0
  let socketError
  // Assertions poll the same received state a normal client would render.
  ws.on('message', (payload) => {
    if (String(payload) === 'pong') return
    const message = JSON.parse(String(payload))
    if (message.type === 'reply') replies.set(message.id, message)
    if (message.type === 'state') {
      latest = message
      frames.push(message)
    }
  })
  ws.on('error', (error) => {
    socketError = error
  })
  async function wait(condition, name, ceiling = 5000) {
    const until = Date.now() + ceiling
    while (Date.now() < until) {
      if (socketError) throw socketError
      const out = condition()
      if (out) return out
      await new Promise((ok) => setTimeout(ok, 15))
    }
    throw new Error(
      name +
        ' not observed. Latest frame: ' +
        JSON.stringify(latest?.phase) +
        ' ' +
        JSON.stringify(latest?.turn),
    )
  }
  await wait(() => frames.some((frame) => frame.kind === 'snapshot'), 'initial snapshot')
  return {
    ws,
    frames,
    get latest() {
      return latest
    },
    get count() {
      return count
    },
    state: (match, name = 'state', ceiling) =>
      wait(() => latest && match(latest) && latest, name, ceiling),
    async send(command, ref = crypto.randomUUID()) {
      count++
      replies.delete(ref)
      ws.send(JSON.stringify({ ...command, id: ref, tableId: id }))
      return wait(() => replies.get(ref), 'reply to ' + command.kind)
    },
    close: () => {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      return new Promise((done) => {
        ws.once('close', done)
        ws.close(1000)
      })
    },
  }
}

export async function seat(client, position) {
  assert.equal((await client.send({ kind: 'seat', position })).ok, true)
}
export async function wager(client, roundId, chips, id) {
  return client.send({ kind: 'bet', roundId, chips }, id)
}
