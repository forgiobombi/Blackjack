import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { fixture } from './runtime.mjs'
import { connect, host, join, makeInvite, seat, table, wager } from './clients.mjs'

const runtime = await fixture()
const clients = []
const started = performance.now()
try {
  const admin = await runtime.newPlayer('load_host', 'superadmin')
  await Promise.all(
    Array.from({ length: 3 }, async (_, tableNumber) => {
      const id = await table(runtime, admin)
      const invite = await makeInvite(runtime, admin, id)
      const players = await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          runtime.newPlayer('load_' + tableNumber + '_' + index),
        ),
      )
      const tableClients = await Promise.all(
        players.map(async (player) => {
          await join(runtime, player, invite.code)
          const ws = await connect(runtime, player, id)
          clients.push(ws)
          return ws
        }),
      )
      const seated = tableClients.slice(0, 7)
      await Promise.all(seated.map((ws, index) => seat(ws, index)))
      await Promise.all(
        tableClients.map((ws) => ws.send({ kind: 'chat', text: 'Hello from the load test' })),
      )
      await host(runtime, admin, id, 'start')
      const view = await seated[0].state((state) => state.phase === 'betting')
      assert.equal(view.spectators, 2)
      const bets = await Promise.all(seated.map((ws) => wager(ws, view.roundId, 25)))
      assert.equal(bets.filter((bet) => bet.ok).length, 7)
      await Promise.all(tableClients.slice(7).map((ws) => ws.close()))
      const reconnected = await Promise.all(
        players.slice(7).map((user) => connect(runtime, user, id)),
      )
      clients.push(...reconnected)
      await runtime.changeClock(id, { deadline: true })
      for (let i = 0; i < 7; i++) {
        const state = await seated[0].state(
          (frame) =>
            frame.phase === 'complete' || (frame.phase === 'playing' && frame.turn.step > i),
        )
        if (state.phase === 'complete') break
        const active = players.findIndex((person) => person.id === state.turn.user)
        assert.equal(
          (
            await seated[active].send({
              kind: 'action',
              action: 'stand',
              roundId: view.roundId,
              step: state.turn.step,
              hand: state.turn.hand,
            })
          ).ok,
          true,
        )
      }
      await seated[0].state((state) => state.phase === 'complete')
      await host(runtime, admin, id, 'close')
    }),
  )
  const db = await runtime.db()
  const rounds = await db.prepare('SELECT count(*) AS n FROM replays').first('n')
  const ledger = await db.prepare('SELECT count(*) AS n FROM wallet_ledger').first('n')
  const rows = await db.prepare('SELECT count(*) AS n FROM round_history').first('n')
  const bytes = await db
    .prepare('SELECT sum(length(CAST(frames AS BLOB))) AS n FROM replays')
    .first('n')
  assert.equal(rounds, 3)
  assert.equal(rows, 21)
  console.log(
    JSON.stringify(
      {
        runtime: 'local workerd / Miniflare',
        seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
        tables: 3,
        activePlayers: 21,
        spectators: 6,
        socketOpens: clients.length,
        httpCalls: runtime.calls,
        websocketCommands: clients.reduce((acc, ws) => acc + ws.count, 0),
        receivedGameSnapshots: clients.reduce((acc, ws) => acc + ws.frames.length, 0),
        rounds,
        playerRoundRows: rows,
        persistedLedgerEntries: ledger,
        replayBytes: bytes,
      },
      null,
      2,
    ),
  )
} finally {
  await Promise.allSettled(clients.map((ws) => ws.close()))
  await runtime.close()
}
