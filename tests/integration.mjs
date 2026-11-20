import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './runtime.mjs'
import { connect, host, join, makeInvite, seat, table, wager } from './clients.mjs'

let runtime, admin, jane, noah
before(async () => {
  runtime = await fixture()
  ;[admin, jane, noah] = await Promise.all([
    runtime.newPlayer('host', 'superadmin'),
    runtime.newPlayer('jane'),
    runtime.newPlayer('noah'),
  ])
})
after(async () => {
  if (runtime) await runtime.close()
})

test('D1 authenticates verified actors, rejects expired sessions and protects privileged endpoints', async () => {
  assert.equal((await runtime.request('/me')).status, 401)
  assert.equal((await runtime.request('/admin', { user: jane })).status, 403)
  assert.equal((await runtime.request('/tables', { user: jane, body: {} })).status, 403)
  const expired = await runtime.newPlayer('expired', 'player', -10)
  assert.equal((await runtime.request('/me', { user: expired })).status, 401)
})

test('Invite preview, single-use membership, invalid token, expiry, revocation and code join', async () => {
  const id = await table(runtime, admin)
  const invitation = await makeInvite(runtime, admin, id, { uses: 1 })
  assert.equal(
    (await runtime.request('/join/preview', { user: jane, body: { invite: 'ABCD2345' } })).status,
    404,
  )
  assert.equal(
    (await runtime.request('/tables/' + id + '/ticket', { user: jane, method: 'POST' })).status,
    403,
  )
  assert.equal(
    (await runtime.request('/join/preview', { user: jane, body: { invite: invitation.token } }))
      .data.table.id,
    id,
  )
  assert.equal(await join(runtime, jane, invitation.code), id)
  assert.equal(
    (await runtime.request('/join', { user: noah, body: { invite: invitation.token } })).data.error,
    'invite_used',
  )
  const next = await makeInvite(runtime, admin, id)
  const db = await runtime.db()
  await db
    .prepare('UPDATE table_invites SET expires_at=? WHERE id=?')
    .bind(Date.now() - 1000, next.id)
    .run()
  assert.equal(
    (await runtime.request('/join', { user: noah, body: { invite: next.code } })).data.error,
    'invite_expired',
  )
  await runtime.request('/tables/' + id + '/invitations/' + next.id, {
    user: admin,
    method: 'POST',
  })
  assert.equal(
    (await runtime.request('/join', { user: noah, body: { invite: next.token } })).data.error,
    'invite_revoked',
  )
  await host(runtime, admin, id, 'close')
})

test('Two users contend for one seat, play a real shared round, persist a private replay and recover a reloaded seat', async () => {
  const id = await table(runtime, admin)
  const { code } = await makeInvite(runtime, admin, id)
  await Promise.all([join(runtime, jane, code), join(runtime, noah, code)])
  const clients = await Promise.all([connect(runtime, jane, id), connect(runtime, noah, id)])
  let [a, b] = clients
  try {
    const claims = await Promise.all([
      a.send({ kind: 'seat', position: 0 }),
      b.send({ kind: 'seat', position: 0 }),
    ])
    assert.equal(claims.filter((reply) => reply.ok).length, 1)
    if (claims[0].ok) await seat(b, 1)
    else await seat(a, 1)
    await host(runtime, admin, id, 'start')
    const view = await a.state((state) => state.phase === 'betting', 'betting opened')
    const round = view.roundId
    const op = crypto.randomUUID()
    assert.ok((await wager(a, round, 25, op)).ok)
    assert.ok((await wager(a, round, 25, op)).ok)
    assert.ok((await wager(b, round, 10)).ok)
    await runtime.changeClock(id, { deadline: true, shoe: ['10', '9', '7', '6', '7', '10', '5'] })
    const live = await a.state((state) => state.phase === 'playing', 'players turn')
    assert.equal(live.dealer[1], null)
    assert.equal(live.dealerTotal, 7)
    const cap = live.turn
    const uid = cap.user
    const spectator = await connect(runtime, uid === jane.id ? jane : noah, id)
    try {
      assert.equal(spectator.latest.controller, false)
      assert.equal(
        (
          await spectator.send({
            kind: 'action',
            action: 'stand',
            roundId: round,
            step: cap.step,
            hand: cap.hand,
          })
        ).error,
        'read_only',
      )
    } finally {
      await spectator.close()
    }
    await a.close()
    a = await connect(runtime, jane, id)
    assert.equal(a.latest.roundId, round)
    assert.equal(a.latest.seats.find((person) => person.id === jane.id).hands[0].cards.length, 2)
    assert.equal(a.latest.controller, true)
    for (let turn = 0; turn < 2; turn++) {
      const current = await a.state(
        (state) => state.phase === 'playing' && state.turn.step === turn + 1,
        'next turn',
      )
      const player = current.turn.user === jane.id ? a : b
      const answer = await player.send({
        kind: 'action',
        action: 'stand',
        roundId: round,
        step: current.turn.step,
        hand: current.turn.hand,
      })
      assert.ok(answer.ok, JSON.stringify(answer))
    }
    const done = await a.state((state) => state.phase === 'complete', 'settlement')
    assert.ok(done.dealer[1])
    const activity = await runtime.request('/history', { user: jane })
    assert.equal(activity.data.rounds[0].id, round)
    assert.equal((await runtime.request('/history/' + round, { user: admin })).status, 404)
    const replay = (await runtime.request('/history/' + round, { user: jane })).data
    assert.equal(replay.frames.find((item) => item.kind === 'deal').dealer[1], null)
    assert.equal(replay.frames.at(-1).phase, 'complete')
    const db = await runtime.db()
    const count = await db
      .prepare(
        "SELECT count(*) AS n FROM wallet_ledger WHERE user_id=? AND round_id=? AND kind='bet'",
      )
      .bind(jane.id, round)
      .first('n')
    assert.equal(count, 1)
    await host(runtime, admin, id, 'start')
    assert.ok(
      (await a.state((state) => state.phase === 'betting' && state.roundId !== round)).roundId,
    )
  } finally {
    await Promise.allSettled([a.close(), b.close()])
    await host(runtime, admin, id, 'close')
  }
})

test('A shared D1 wallet serializes simultaneous full-balance bets across two tables', async () => {
  const player = await runtime.newPlayer('cross_table')
  const ids = await Promise.all([
    table(runtime, admin, { maxBet: 10000 }),
    table(runtime, admin, { maxBet: 10000 }),
  ])
  const clients = []
  try {
    for (const id of ids) {
      await join(runtime, player, (await makeInvite(runtime, admin, id)).code)
      const client = await connect(runtime, player, id)
      clients.push(client)
      await seat(client, 0)
      await host(runtime, admin, id, 'start')
    }
    const states = await Promise.all(
      clients.map((client) => client.state((state) => state.phase === 'betting')),
    )
    const attempts = await Promise.all(
      clients.map((client, index) => wager(client, states[index].roundId, 10000)),
    )
    assert.equal(attempts.filter((reply) => reply.ok).length, 1)
    assert.equal(attempts.find((reply) => !reply.ok).error, 'balance')
    assert.equal((await runtime.request('/me', { user: player })).data.balance, 0)
    for (const id of ids) await host(runtime, admin, id, 'close')
    assert.equal((await runtime.request('/me', { user: player })).data.balance, 100000)
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
  }
})

test('A failing settlement is retried from a persisted intent across a workerd restart', async () => {
  const id = await table(runtime, admin)
  const client = await connect(runtime, admin, id)
  let second
  const db = await runtime.db()
  try {
    await seat(client, 0)
    await host(runtime, admin, id, 'start')
    const opening = await client.state((state) => state.phase === 'betting')
    const round = opening.roundId
    assert.ok((await wager(client, round, 20)).ok)
    await db
      .prepare(
        "CREATE TRIGGER fixture_fail_settlement BEFORE INSERT ON wallet_ledger WHEN NEW.kind='settlement' BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
      )
      .run()
    await runtime.changeClock(id, { deadline: true, shoe: ['10', '7', '9', '10'] })
    const live = await client.state((state) => state.phase === 'playing')
    assert.ok(
      (
        await client.send({
          kind: 'action',
          action: 'stand',
          roundId: round,
          step: live.turn.step,
          hand: live.turn.hand,
        })
      ).ok,
    )
    await client.state((state) => state.recovering, 'recovering notification')
    await client.close()
    await runtime.restart()
    const after = await runtime.db()
    await after.prepare('DROP TRIGGER fixture_fail_settlement').run()
    second = await connect(runtime, admin, id)
    const frame = await second.state(
      (state) => state.phase === 'complete',
      'reconciled settlement',
      9000,
    )
    assert.equal(frame.roundId, round)
    assert.equal(frame.seats[0].hands[0].result, 'win')
    assert.equal(
      await after
        .prepare("SELECT count(*) AS n FROM wallet_ledger WHERE round_id=? AND kind='settlement'")
        .bind(round)
        .first('n'),
      1,
    )
    assert.equal((await runtime.request('/history/' + round, { user: admin })).status, 200)
  } finally {
    await client.close()
    await second?.close()
    await (await runtime.db()).prepare('DROP TRIGGER IF EXISTS fixture_fail_settlement').run()
    await runtime.request('/tables/' + id + '/admin', {
      user: admin,
      body: { id: crypto.randomUUID(), action: 'close' },
    })
  }
})

test('Automatic alarm warns at 25 and 29 minutes and closes at 30 despite chat and heartbeat', async () => {
  const id = await table(runtime, admin)
  const invite = await makeInvite(runtime, admin, id)
  const client = await connect(runtime, admin, id)
  try {
    await runtime.changeClock(id, { elapsed: 25 * 60000 + 300 })
    await client.state((state) => state.warning === 1, '25 minute warning')
    assert.ok((await client.send({ kind: 'chat', text: 'Still here' })).ok)
    client.ws.send('ping')
    await runtime.changeClock(id, { elapsed: 29 * 60000 + 300 })
    await client.state((state) => state.warning === 2, '29 minute warning')
    await runtime.changeClock(id, { elapsed: 30 * 60000 + 300 })
    await client.state((state) => state.phase === 'closed', 'automatic close')
    assert.equal(
      (await runtime.request('/join', { user: jane, body: { invite: invite.token } })).data.error,
      'closed',
    )
    assert.equal(
      (await runtime.request('/tables/' + id, { user: admin })).data.table.status,
      'closed',
    )
  } finally {
    await client.close()
  }
})

test('Host close stops admissions, completes a dealt hand and persists one closure', async () => {
  const id = await table(runtime, admin)
  const client = await connect(runtime, admin, id)
  try {
    await seat(client, 0)
    await host(runtime, admin, id, 'start')
    const round = (await client.state((state) => state.phase === 'betting')).roundId
    assert.ok((await wager(client, round, 25)).ok)
    await runtime.changeClock(id, { deadline: true, shoe: ['9', '8', '9', '10'] })
    const live = await client.state((state) => state.phase === 'playing')
    await host(runtime, admin, id, 'close')
    await client.state((state) => state.closing)
    assert.ok(
      (
        await client.send({
          kind: 'action',
          action: 'stand',
          roundId: round,
          step: live.turn.step,
          hand: live.turn.hand,
        })
      ).ok,
    )
    await client.state((state) => state.phase === 'closed', 'finished then closed')
    assert.equal((await runtime.request('/history/' + round, { user: admin })).status, 200)
  } finally {
    await client.close()
  }
})

test('A global suspension closes live connections and blocks further table access', async () => {
  const peer = await runtime.newPlayer('moderated')
  const id = await table(runtime, admin)
  await join(runtime, peer, (await makeInvite(runtime, admin, id)).token)
  const client = await connect(runtime, peer, id)
  const closed = new Promise((done) => client.ws.once('close', (code) => done(code)))
  try {
    assert.equal(
      (
        await runtime.request('/admin/users/' + peer.id, {
          user: admin,
          body: { id: crypto.randomUUID(), action: 'suspend' },
        })
      ).status,
      200,
    )
    assert.equal(await closed, 4003)
    assert.equal((await runtime.request('/me', { user: peer })).data.error, 'suspended')
  } finally {
    await client.close()
    await host(runtime, admin, id, 'close')
  }
})

test('Verified signup, one-time browser return, refresh and password recovery exercise the HTTP auth flow', async () => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', Buffer.from(verifier)),
  ).toString('base64url')
  const email = 'account_flow@example.test'
  const password = 'first-fixture-password'
  async function form(mode, fields) {
    return fetch(runtime.base + '/auth/' + mode + '?lang=it&c=' + challenge, {
      method: 'POST',
      headers: { Origin: runtime.base },
      body: new URLSearchParams({ email, ...fields }),
      redirect: 'manual',
    })
  }
  async function take(response) {
    assert.equal(response.status, 303)
    const redirect = new URL(response.headers.get('Location'))
    assert.equal(redirect.pathname, '/Blackjack/')
    const code = redirect.hash.split('/').at(-1)
    assert.equal(
      (await runtime.request('/auth/exchange', { body: { code, verifier: 'a'.repeat(43) } }))
        .status,
      401,
    )
    const session = await runtime.request('/auth/exchange', { body: { code, verifier } })
    assert.equal(session.status, 200, JSON.stringify(session))
    assert.equal(
      (await runtime.request('/auth/exchange', { body: { code, verifier } })).status,
      401,
    )
    return session.data
  }
  const registration = await form('register', {
    username: 'account_flow',
    password,
    confirm: password,
  })
  assert.equal(registration.status, 200)
  assert.match(await registration.text(), /Verifica la tua email/)
  const blocked = await form('login', { password })
  assert.match(await blocked.text(), /Verifica la tua email/)
  const credentials = await take(await form('verify', { otp: '536781' }))
  const profile = await runtime.request('/me', { user: credentials })
  assert.equal(profile.data.username, 'account_flow')
  assert.equal(profile.data.preferences.locale, 'it')
  const refreshed = await runtime.request('/auth/refresh', {
    body: { refresh: credentials.refresh },
  })
  assert.equal(refreshed.status, 200)
  assert.equal(
    (await runtime.request('/auth/logout', { user: refreshed.data, method: 'POST' })).status,
    200,
  )
  assert.equal((await runtime.request('/me', { user: refreshed.data })).status, 401)
  assert.equal((await form('forgot', {})).status, 200)
  const replacement = 'replacement-fixture-password'
  await take(await form('reset', { otp: '536781', password: replacement, confirm: replacement }))
  assert.equal((await form('login', { password })).status, 400)
  await take(await form('login', { password: replacement }))
})
