import { DurableObject } from 'cloudflare:workers'
import { newShoe } from '../../../packages/engine/cards.ts'
import {
  actionCost,
  act,
  bet,
  cancelRound,
  clearBet,
  deal,
  legalActions,
  openRound,
  timeout,
} from '../../../packages/engine/round.ts'
import { LAST_WARNING_MS, MIN_WARNING_MS, UNIT } from '../../../packages/protocol/rules.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import type {
  ChatMessage,
  Command,
  EventKind,
  Frame,
  Reaction,
  Reply,
  View,
} from '../../../packages/protocol/types.ts'
import { Fault, object, parseCommand, uuid } from '../../../packages/protocol/validation.ts'
import type { Env, Principal } from './env.ts'
import { digest, errorResponse, json, token } from './http.ts'
import {
  activeRound,
  dueAt,
  finalize,
  frame,
  framesFor,
  idleAt,
  receipt,
  recordReceipt,
  touch,
} from './table-model.ts'
import type { Envelope, Pending, Projection, TableState } from './table-model.ts'
import { PROTOCOL, canManage } from './tables.ts'
import { reserveOrRelease, settle } from './wallet.ts'
import type { Entry } from './wallet.ts'

const SPECTATOR_LIMIT = 24
const SOCKET_LEASE = 12 * 60_000
const MAX_QUEUE = 56
const CHAT_RETENTION = 60 * 60_000

type SocketInfo = { actor: Principal; controller: boolean; until: number; id: string }
type Extras = {
  messages?: ChatMessage[]
  reaction?: { name: string; user: string; value: Reaction }
  visuals?: Frame[]
}
type AdminInput = {
  actor: Principal
  id: string
  action: string
  target?: string
  settings?: TableSettings
  enabled?: number
}
type Access = {
  until: number
  muted: boolean
  role: Principal['role']
  balance: number
  name: string
  avatar: Principal['avatar']
}

export class BlackjackTable extends DurableObject<Env> {
  private envelope: Envelope | null | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private access = new Map<string, Access>()
  private traffic = new WeakMap<WebSocket, { since: number; count: number; reaction?: number }>()
  private announcements = new Map<string, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL)',
    )
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    this.queued++
    const operation = this.tail.then(job).finally(() => {
      this.queued--
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  private async load() {
    if (this.envelope === undefined)
      this.envelope = (await this.ctx.storage.get<Envelope>('table')) ?? null
    return this.envelope
  }

  private info(socket: WebSocket): SocketInfo {
    return socket.deserializeAttachment() as SocketInfo
  }

  private sockets() {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN)
  }

  private connected() {
    const now = Date.now()
    return new Set(
      this.sockets()
        .map((ws) => this.info(ws))
        .filter((info) => info.until > now)
        .map((info) => info.actor.id),
    )
  }

  private async schedule(envelope: Envelope) {
    const { current, pending } = envelope
    if (current.closedAt) return this.ctx.storage.deleteAlarm()
    const socketDeadlines = this.sockets().map((ws) => this.info(ws).until)
    const other =
      pending?.retryAt ??
      Math.min(
        dueAt(current) ?? Infinity,
        ...socketDeadlines,
        current.chat.length ? current.chat[0].at + CHAT_RETENTION : Infinity,
      )
    if (Number.isFinite(other)) {
      const alarm = Math.max(other, Date.now() + 10)
      // Preserve an earlier alarm when a connection only extends a lease.
      const existing = await this.ctx.storage.getAlarm()
      if (existing !== alarm) await this.ctx.storage.setAlarm(alarm)
    }
  }

  private async save(envelope: Envelope) {
    const { current, pending } = envelope
    const deadlines = this.sockets().map((ws) => this.info(ws).until)
    const soonest =
      pending?.retryAt ??
      Math.min(
        dueAt(current) ?? Infinity,
        ...deadlines,
        current.chat.length ? current.chat[0].at + CHAT_RETENTION : Infinity,
      )
    // Issue state/alarm writes together before awaiting either. The SQLite storage write batch is atomic.
    const deadline =
      !current.closedAt && Number.isFinite(soonest)
        ? this.ctx.storage.setAlarm(Math.max(soonest, Date.now() + 10))
        : this.ctx.storage.deleteAlarm()
    await Promise.all([this.ctx.storage.put('table', envelope), deadline])
    this.envelope = envelope
  }

  private makeView(
    state: TableState,
    info: SocketInfo,
    kind: EventKind,
    extras: Extras = {},
  ): View {
    const connected = this.connected()
    const user = info.actor.id
    const wallet = this.access.get(info.id)?.balance ?? info.actor.balance
    const seating = !state.closedAt && !state.closing && !state.paused && this.seatWindow(state)
    const actions =
      info.controller && !state.paused && !this.envelope?.pending && state.round
        ? legalActions(state.round, user).filter(
            (action) => actionCost(state.round!, user, action) <= wallet,
          )
        : []
    return {
      ...frame(state, kind, Date.now(), connected),
      ...extras,
      type: 'state',
      sequence: state.version,
      tableId: state.id,
      settings: state.settings,
      serverTime: Date.now(),
      owner: canManage(info.actor, state.owner),
      controller: info.controller,
      joined: true,
      canSeat: Boolean(seating),
      actions,
      wallet,
      deadline: state.round?.deadline ?? state.nextAt,
      idleAt: idleAt(state),
      warning: state.warning,
      paused: state.paused,
      joinEnabled: state.joinEnabled,
      closing: Boolean(state.closing),
      recovering: Boolean(this.envelope?.pending),
      spectators: [...connected].filter((id) => !state.seats.some((seat) => seat.user === id))
        .length,
    }
  }

  private send(socket: WebSocket, message: Reply | View) {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      /* The next connection receives the authoritative snapshot. */
    }
  }

  private publish(state: TableState, kind: EventKind, extras: Extras = {}) {
    for (const socket of this.sockets()) {
      const info = this.info(socket)
      if (info.until > Date.now()) this.send(socket, this.makeView(state, info, kind, extras))
    }
  }

  private endSockets(code: number, reason: string, user?: string) {
    const sockets = user ? this.ctx.getWebSockets('user:' + user) : this.sockets()
    for (const socket of sockets) {
      this.access.delete(this.info(socket).id)
      try {
        socket.close(code, reason)
      } catch {
        /* Already closed. */
      }
    }
  }

  private async freshAccess(info: SocketInfo, table: string, force = false): Promise<Access> {
    const now = Date.now()
    if (now >= info.until) throw new Fault('session_expired', 401)
    const previous = this.access.get(info.id)
    if (!force && previous && previous.until > now) return previous
    const row = await this.env.DB.prepare(
      'SELECT p.role,p.display_name,p.avatar,p.suspended,w.balance,coalesce(r.banned,0) AS banned,coalesce(r.muted,0) AS muted,' +
        'm.user_id,t.owner_id,(s.id IS NOT NULL) AS revoked FROM profiles p JOIN wallets w ON w.user_id=p.id JOIN game_tables t ON t.id=? ' +
        'LEFT JOIN table_memberships m ON m.table_id=t.id AND m.user_id=p.id LEFT JOIN table_restrictions r ON r.table_id=t.id AND r.user_id=p.id ' +
        'LEFT JOIN revoked_sessions s ON s.id=? AND s.expires_at>? WHERE p.id=?',
    )
      .bind(table, info.actor.session, now, info.actor.id)
      .first<{
        suspended: number
        banned: number
        muted: number
        user_id: string | null
        owner_id: string
        revoked: number
        role: Principal['role']
        balance: number
        display_name: string
        avatar: Principal['avatar']
      }>()
    if (!row || row.revoked) throw new Fault('session_expired', 401)
    if (row.suspended) throw new Fault('suspended', 403)
    if (row.banned) throw new Fault('banned', 403)
    if (!row.user_id && !canManage({ ...info.actor, role: row.role }, row.owner_id))
      throw new Fault('membership', 403)
    const access = {
      until: now + 7000,
      muted: Boolean(row.muted),
      role: row.role,
      balance: row.balance,
      name: row.display_name,
      avatar: row.avatar,
    }
    this.access.set(info.id, access)
    return access
  }

  private async refreshWallets(users: string[]) {
    if (!users.length) return
    const sockets = this.sockets().filter((ws) => users.includes(this.info(ws).actor.id))
    if (!sockets.length) return
    const placeholders = users.map(() => '?').join(',')
    try {
      const rows = await this.env.DB.prepare(
        'SELECT user_id,balance FROM wallets WHERE user_id IN (' + placeholders + ')',
      )
        .bind(...users)
        .all<{ user_id: string; balance: number }>()
      const balances = new Map(rows.results.map((row) => [row.user_id, row.balance]))
      for (const ws of sockets) {
        const info = this.info(ws)
        const balance = balances.get(info.actor.id)
        if (balance === undefined) continue
        const access = this.access.get(info.id)
        if (access) access.balance = balance
        if (!access || info.actor.balance !== balance)
          ws.serializeAttachment({ ...info, actor: { ...info.actor, balance } })
      }
    } catch {
      for (const ws of sockets) this.access.delete(this.info(ws).id)
    }
  }

  private async applyProjection(state: TableState, projection: Projection) {
    const db = this.env.DB
    const statements: D1PreparedStatement[] = []
    if (projection.kind === 'create') {
      statements.push(
        db
          .prepare(
            'INSERT INTO game_tables(id,owner_id,settings,private,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(
            state.id,
            state.owner,
            JSON.stringify(state.settings),
            Number(state.settings.private),
            state.createdAt,
          ),
        db
          .prepare(
            'INSERT INTO table_memberships(table_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(state.id, state.owner, state.createdAt),
      )
    }
    if (projection.kind === 'settings')
      statements.push(
        db
          .prepare('UPDATE game_tables SET settings=?,private=? WHERE id=?')
          .bind(JSON.stringify(state.settings), Number(state.settings.private), state.id),
      )
    if (projection.kind === 'joining')
      statements.push(
        db
          .prepare('UPDATE game_tables SET join_enabled=? WHERE id=?')
          .bind(Number(state.joinEnabled), state.id),
      )
    if (projection.kind === 'closing')
      statements.push(
        db
          .prepare(
            "UPDATE game_tables SET status='closing',join_enabled=0 WHERE id=? AND status='open'",
          )
          .bind(state.id),
      )
    if (projection.kind === 'closed')
      statements.push(
        db
          .prepare(
            "UPDATE game_tables SET status='closed',join_enabled=0,closed_at=?,close_reason=? WHERE id=?",
          )
          .bind(state.closedAt, state.closing, state.id),
        db
          .prepare('UPDATE table_invites SET revoked=1 WHERE table_id=? AND revoked=0')
          .bind(state.id),
      )
    if (projection.moderation) {
      const { user, action } = projection.moderation
      if (action === 'ban' || action === 'unban')
        statements.push(
          db
            .prepare(
              'INSERT INTO table_restrictions(table_id,user_id,banned) VALUES(?,?,?) ON CONFLICT(table_id,user_id) DO UPDATE SET banned=excluded.banned',
            )
            .bind(state.id, user, Number(action === 'ban')),
        )
      if (action === 'mute' || action === 'unmute')
        statements.push(
          db
            .prepare(
              'INSERT INTO table_restrictions(table_id,user_id,muted) VALUES(?,?,?) ON CONFLICT(table_id,user_id) DO UPDATE SET muted=excluded.muted',
            )
            .bind(state.id, user, Number(action === 'mute')),
        )
      if (action === 'remove' || action === 'ban')
        statements.push(
          db
            .prepare('DELETE FROM table_memberships WHERE table_id=? AND user_id=?')
            .bind(state.id, user),
        )
    }
    if (projection.audit) {
      const { id, actor, action, target, data, at } = projection.audit
      statements.push(
        db
          .prepare(
            'INSERT INTO audit_logs(id,actor_id,action,target,metadata,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(id, actor, action, target, JSON.stringify(data ?? {}), at),
      )
    }
    if (statements.length) await db.batch(statements)
  }

  private async commit(
    current: TableState,
    next: TableState,
    kind: EventKind,
    options: Partial<Pending> = {},
  ) {
    next.version = current.version + 1
    if (!options.entry && !options.settlement && !options.projection) {
      await this.save({ current: next })
      this.publish(next, kind, { visuals: options.visuals })
      return
    }
    const pending: Pending = {
      next,
      kind,
      visuals: [],
      attempts: 0,
      retryAt: Date.now() + 5000,
      ...options,
    }
    await this.save({ current, pending })
    await this.recover()
  }

  private async recover() {
    const envelope = await this.load()
    if (!envelope?.pending) return
    const { current, pending } = envelope
    let accepted = true
    try {
      if (pending.entry) accepted = await reserveOrRelease(this.env.DB, pending.entry)
      if (pending.settlement)
        await settle(this.env.DB, pending.settlement.entries, pending.settlement.data)
      if (pending.projection) await this.applyProjection(pending.next, pending.projection)
    } catch (error) {
      console.error(
        'Table reconciliation deferred',
        error instanceof Error ? error.name : 'unknown',
      )
      const attempts = pending.attempts + 1
      await this.save({
        current,
        pending: {
          ...pending,
          attempts,
          retryAt: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6)),
        },
      })
      this.publish(current, 'recovering')
      throw new Fault('recovering', 503)
    }
    const next = accepted ? pending.next : structuredClone(current)
    if (!accepted && pending.command && pending.actor)
      recordReceipt(next, pending.actor, pending.command, 'balance', true)
    await this.save({ current: next })
    const moderation = pending.projection?.moderation
    if (moderation) {
      for (const ws of this.ctx.getWebSockets('user:' + moderation.user))
        this.access.delete(this.info(ws).id)
      if (moderation.action === 'ban' || moderation.action === 'remove')
        this.endSockets(
          4003,
          moderation.action === 'ban' ? 'banned' : 'membership',
          moderation.user,
        )
    }
    if (pending.entry) await this.refreshWallets([pending.entry.user])
    if (pending.settlement)
      await this.refreshWallets(pending.settlement.data.histories.map((history) => history.user))
    this.publish(next, accepted ? pending.kind : 'snapshot', {
      visuals: accepted ? pending.visuals : [],
    })
    if (next.closedAt) {
      this.endSockets(4004, 'closed')
      this.ctx.storage.sql.exec('DELETE FROM tickets')
    }
  }

  private seatWindow(state: TableState) {
    if (!state.round) return true
    if (state.round.phase === 'complete') return state.settings.lateEntry
    return state.round.phase === 'betting' && state.settings.lateEntry
  }

  private liveRoundStart(state: TableState, at: number) {
    state.nextAt = undefined
    state.round = openRound(
      crypto.randomUUID(),
      at,
      state.settings.rules,
      state.settings.bettingSeconds,
      state.settings.turnSeconds,
    )
    state.frames = []
    state.roundReceipts = []
    state.lobbyTouches = []
  }

  private async tick(now: number) {
    let envelope = await this.load()
    if (!envelope || envelope.current.closedAt) return
    if (envelope.pending) {
      if (envelope.pending.retryAt > now) return
      await this.recover()
    }
    for (const ws of this.sockets()) {
      if (this.info(ws).until <= now) {
        this.access.delete(this.info(ws).id)
        try {
          ws.close(4001, 'session_expired')
        } catch {
          /* Already closed. */
        }
      }
    }
    for (let iteration = 0; iteration < 120; iteration++) {
      envelope = (await this.load())!
      const current = envelope.current
      if (current.closedAt) break
      const next = structuredClone(current)
      if (next.chat[0]?.at <= now - CHAT_RETENTION) {
        next.chat = next.chat.filter((item) => item.at > now - CHAT_RETENTION)
        await this.save({ current: next })
        continue
      }
      const round = next.round
      if (round?.phase === 'settling') {
        const result = finalize(next, now)
        if (
          next.settings.autoNext &&
          !next.closing &&
          !next.paused &&
          !round.cancelled &&
          next.seats.some((seat) => seat.ready)
        )
          next.nextAt = now + 6500
        await this.commit(current, next, 'settled', {
          settlement: result,
          visuals: [result.complete],
        })
        continue
      }
      if (now >= idleAt(next) && !next.closing) {
        next.closing = 'idle'
        next.joinEnabled = false
        next.paused = false
        next.nextAt = undefined
        await this.commit(current, next, 'closing', { projection: { kind: 'closing' } })
        continue
      }
      if (
        next.closing &&
        (!activeRound(next) || now >= idleAt(next) || round?.phase === 'betting')
      ) {
        if (round && activeRound(next) && round.players.length) {
          const cues = framesFor(next, now)
          if (round.phase === 'betting') cancelRound(round, cues.emit)
          else timeout(round, next.shoe!, Math.min(round.deadline ?? now, now), cues.emit)
          await this.commit(current, next, cues.visuals[0]?.kind ?? 'closing', {
            visuals: cues.visuals,
          })
          continue
        }
        next.closedAt = now
        next.joinEnabled = false
        next.round = undefined
        next.nextAt = undefined
        next.shoe = undefined
        next.seats = []
        next.frames = []
        next.chat = []
        next.receipts = []
        next.roundReceipts = []
        next.lobbyTouches = []
        const audit = {
          id: 'close:' + next.id,
          actor: null,
          action: 'closed_' + next.closing,
          target: next.id,
          at: now,
        }
        await this.commit(current, next, 'closed', { projection: { kind: 'closed', audit } })
        break
      }
      if (round?.deadline !== undefined && now >= round.deadline) {
        const roundTime = round.deadline
        const cues = framesFor(next, now)
        if (round.phase === 'betting') {
          if (!round.players.length) {
            next.round = undefined
            next.frames = []
            await this.commit(current, next, 'snapshot')
            continue
          }
          const remaining = next.shoe ? next.shoe.cards.length - next.shoe.cursor : 0
          if (
            !next.shoe ||
            next.shoe.cursor >= (next.shoe.cards.length * round.rules.penetration) / 100 ||
            remaining < round.players.length * 2 + 12
          ) {
            next.shoe = newShoe(round.rules.decks)
            cues.emit('shuffle')
          }
          deal(round, next.shoe, roundTime, cues.emit)
        } else {
          timeout(round, next.shoe!, roundTime, cues.emit)
        }
        await this.commit(
          current,
          next,
          cues.visuals.find((item) => item.kind === 'deal')?.kind ??
            cues.visuals[0]?.kind ??
            'turn',
          { visuals: cues.visuals },
        )
        continue
      }
      if (next.nextAt !== undefined && next.nextAt <= now) {
        const connected = this.connected()
        const shouldStart =
          !next.paused &&
          !next.closing &&
          next.seats.some((seat) => seat.ready && connected.has(seat.user))
        if (shouldStart) this.liveRoundStart(next, now)
        else next.nextAt = undefined
        await this.commit(current, next, shouldStart ? 'betting' : 'snapshot')
        continue
      }
      const warning =
        now >= next.lastActive + LAST_WARNING_MS
          ? 2
          : now >= next.lastActive + MIN_WARNING_MS
            ? 1
            : 0
      if (warning > next.warning) {
        next.warning = warning
        await this.commit(current, next, 'warning')
        continue
      }
      const connected = this.connected()
      if (!activeRound(next)) {
        next.seats = next.seats.filter(
          (seat) =>
            !seat.retire &&
            (!seat.offlineAt || seat.offlineAt + 120_000 > now || connected.has(seat.user)),
        )
        if (next.seats.length !== current.seats.length) {
          await this.commit(current, next, 'seat')
          continue
        }
      }
      break
    }
    const latest = await this.load()
    if (latest) await this.schedule(latest)
  }

  async alarm() {
    try {
      await this.serial(() => this.tick(Date.now()))
    } catch (error) {
      if (!(error instanceof Fault && error.code === 'recovering')) throw error
    }
  }

  private async start(input: { id: string; actor: Principal; settings: TableSettings }) {
    if (!canManage(input.actor)) throw new Fault('forbidden', 403)
    const saved = await this.load()
    if (saved) {
      if (saved.current.owner !== input.actor.id) throw new Fault('forbidden', 403)
      if (saved.pending) await this.recover()
      const state = (await this.load())!.current
      return json({
        table: {
          id: state.id,
          ownerId: state.owner,
          createdAt: state.createdAt,
          settings: state.settings,
          status: state.closedAt ? 'closed' : 'open',
        },
      })
    }
    const now = Date.now()
    const state: TableState = {
      id: input.id,
      owner: input.actor.id,
      createdAt: now,
      settings: input.settings,
      lastActive: now,
      warning: 0,
      version: 0,
      paused: false,
      joinEnabled: true,
      seats: [],
      frames: [],
      chat: [],
      receipts: [],
      roundReceipts: [],
      lobbyTouches: [],
    }
    const audit = {
      id: 'create:' + state.id,
      actor: input.actor.id,
      action: 'create',
      target: state.id,
      at: now,
    }
    await this.commit(state, structuredClone(state), 'snapshot', {
      projection: { kind: 'create', audit },
    })
    return json(
      {
        table: {
          id: state.id,
          ownerId: state.owner,
          createdAt: now,
          settings: state.settings,
          status: 'open',
        },
      },
      201,
    )
  }

  private preview(state: TableState, actor: Principal, existing: boolean) {
    if (state.closing || state.closedAt || (!state.joinEnabled && !existing))
      throw new Fault('closed', 409)
    const connected = this.connected()
    const seats = state.seats.length
    const mine = state.seats.some((seat) => seat.user === actor.id)
    const canSeat = seats < state.settings.maxPlayers && this.seatWindow(state)
    if (!existing && !mine && !canSeat && !state.settings.spectators)
      throw new Fault('table_full', 409)
    if (
      this.sockets().length >= state.settings.maxPlayers + SPECTATOR_LIMIT &&
      !connected.has(actor.id)
    )
      throw new Fault('table_full', 409)
    return json({
      seats,
      canSeat,
      spectators: [...connected].filter((id) => !state.seats.some((seat) => seat.user === id))
        .length,
    })
  }

  private async makeTicket(state: TableState, actor: Principal) {
    if (
      state.closedAt ||
      (state.closing &&
        !state.seats.some((seat) => seat.user === actor.id) &&
        !canManage(actor, state.owner))
    )
      throw new Fault('closed', 410)
    const now = Date.now()
    const secret = token(32)
    const key = await digest(secret)
    this.ctx.storage.sql.exec('DELETE FROM tickets WHERE expires<=?', now)
    this.ctx.storage.sql.exec(
      'INSERT INTO tickets VALUES(?,?,?)',
      key,
      JSON.stringify(actor),
      now + 30_000,
    )
    return json({ ticket: secret })
  }

  private async upgradeSocket(state: TableState, request: Request) {
    const secret = request.headers.get('X-Table-Ticket')
    if (!secret) throw new Fault('auth_required', 401)
    const record = this.ctx.storage.sql
      .exec<{ payload: string }>(
        'DELETE FROM tickets WHERE id=? AND expires>? RETURNING payload',
        await digest(secret),
        Date.now(),
      )
      .toArray()[0]
    if (!record) throw new Fault('session_expired', 401)
    const actor = JSON.parse(record.payload) as Principal
    if (
      state.closedAt ||
      (state.closing &&
        !state.seats.some((seat) => seat.user === actor.id) &&
        !canManage(actor, state.owner))
    )
      throw new Fault('closed', 410)
    const mine = this.ctx
      .getWebSockets('user:' + actor.id)
      .filter((ws) => ws.readyState === WebSocket.OPEN)
    if (this.sockets().length >= state.settings.maxPlayers + SPECTATOR_LIMIT || mine.length >= 3)
      throw new Fault('table_full', 409)
    const isSeated = state.seats.some((seat) => seat.user === actor.id)
    if (
      !isSeated &&
      !state.settings.spectators &&
      (state.seats.length >= state.settings.maxPlayers || !this.seatWindow(state)) &&
      !canManage(actor, state.owner)
    )
      throw new Fault('table_full', 409)
    const info: SocketInfo = {
      actor,
      controller: !mine.some((ws) => this.info(ws).controller && this.info(ws).until > Date.now()),
      until: Math.min(actor.expiry, Date.now() + SOCKET_LEASE),
      id: crypto.randomUUID(),
    }
    const access = await this.freshAccess(info, state.id, true)
    info.actor = {
      ...info.actor,
      name: access.name,
      avatar: access.avatar,
      role: access.role,
      balance: access.balance,
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['user:' + actor.id])
    pair[1].serializeAttachment(info)
    const envelope = (await this.load())!
    const previous = state.seats.find((seat) => seat.user === actor.id)
    if (previous?.offlineAt && !envelope.pending) {
      const current = structuredClone(state)
      const seat = current.seats.find((entry) => entry.user === actor.id)!
      seat.offlineAt = undefined
      await this.save({ current })
      state = current
    } else {
      await this.schedule(envelope)
    }
    this.publish(state, 'connected')
    this.send(pair[1], this.makeView(state, info, 'snapshot', { messages: state.chat }))
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    })
  }

  async fetch(request: Request) {
    if (this.queued >= MAX_QUEUE) return json({ error: 'rate_limit' }, 429)
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname.slice(1)
        if (path === 'init') return await this.start(await request.json())
        await this.tick(Date.now()).catch((error) => {
          if (path !== 'connect' && path !== 'ticket') throw error
          if (!(error instanceof Fault && error.code === 'recovering')) throw error
        })
        const envelope = await this.load()
        if (!envelope) throw new Fault('not_found', 404)
        const state = envelope.current
        if (path === 'connect') return await this.upgradeSocket(state, request)
        const data = await request.json<Record<string, unknown>>()
        if (path === 'preview')
          return this.preview(state, data.actor as Principal, Boolean(data.existing))
        if (path === 'ticket') return await this.makeTicket(state, data.actor as Principal)
        if (path === 'admin') return await this.admin(envelope, data as AdminInput)
        if (path === 'presence') {
          const ids = Array.isArray(data.users) ? data.users.slice(0, 25) : []
          const connected = this.connected()
          return json({ online: ids.filter((id) => typeof id === 'string' && connected.has(id)) })
        }
        if (path === 'status')
          return json({
            seats: state.seats.length,
            connections: this.sockets().length,
            phase: frame(state, 'snapshot', 0).phase,
            spectators: [...this.connected()].filter(
              (id) => !state.seats.some((seat) => seat.user === id),
            ).length,
            expiresAt: idleAt(state),
            paused: state.paused,
            recovering: Boolean(envelope.pending),
          })
        if (path === 'disconnect') {
          const user = uuid(data.user)
          this.endSockets(4003, 'suspended', user)
          return json({ ok: true })
        }
        if (path === 'message') {
          const message = state.chat.find(
            (item) => item.id === data.id && item.at > Date.now() - CHAT_RETENTION,
          )
          if (!message || message.author === (data.actor as Principal).id)
            throw new Fault('not_found', 404)
          return json(message)
        }
        throw new Fault('not_found', 404)
      } catch (error) {
        return errorResponse(error)
      }
    })
  }

  private async admin(envelope: Envelope, data: AdminInput) {
    const current = envelope.current
    if (!canManage(data.actor, current.owner)) throw new Fault('forbidden', 403)
    if (receipt(current, data.actor.id, data.id)) return json({ ok: true })
    if (current.closedAt) throw new Fault('closed', 410)
    if (envelope.pending) throw new Fault('recovering', 503)
    if (current.closing && data.action !== 'close') throw new Fault('closed', 409)
    const next = structuredClone(current)
    const now = Date.now()
    let kind: EventKind = 'settings'
    const audit = {
      id: 'table:' + current.id + ':' + data.id,
      actor: data.actor.id,
      action: data.action,
      target: current.id,
      data: data.target ? { user: data.target } : {},
      at: now,
    }
    const projection: Projection = { kind: 'audit', audit }
    switch (data.action) {
      case 'start':
        if (activeRound(next) || next.paused || !next.seats.length)
          throw new Fault('illegal_action', 409)
        this.liveRoundStart(next, now)
        kind = 'betting'
        break
      case 'pause':
        if (activeRound(next) || next.paused) throw new Fault('between_rounds', 409)
        next.paused = true
        next.nextAt = undefined
        kind = 'pause'
        break
      case 'resume':
        if (!next.paused) throw new Fault('illegal_action', 409)
        next.paused = false
        kind = 'resume'
        break
      case 'close':
        if (next.closing) return json({ ok: true })
        next.closing = 'admin'
        next.joinEnabled = false
        next.paused = false
        next.nextAt = undefined
        kind = 'closing'
        projection.kind = 'closing'
        break
      case 'settings':
        if (activeRound(next) || !data.settings) throw new Fault('between_rounds', 409)
        if (next.seats.some((seat) => seat.position >= data.settings!.maxPlayers))
          throw new Fault('seat_conflict', 409)
        if (next.settings.rules.decks !== data.settings.rules.decks) next.shoe = undefined
        next.settings = data.settings
        if (!next.settings.autoNext) next.nextAt = undefined
        projection.kind = 'settings'
        break
      case 'joining':
        if (next.joinEnabled === Boolean(data.enabled)) return json({ ok: true })
        next.joinEnabled = Boolean(data.enabled)
        projection.kind = 'joining'
        break
      case 'remove':
      case 'ban':
      case 'unban':
      case 'mute':
      case 'unmute': {
        const user = data.target!
        if (
          user === current.owner ||
          !(await this.env.DB.prepare('SELECT 1 FROM profiles WHERE id=?').bind(user).first())
        )
          throw new Fault('not_found', 404)
        const seat = next.seats.find((entry) => entry.user === user)
        if (seat && (data.action === 'remove' || data.action === 'ban')) {
          if (activeRound(next) && next.round!.players.some((player) => player.user === user))
            seat.retire = true
          else next.seats = next.seats.filter((entry) => entry.user !== user)
        }
        projection.kind = 'moderation'
        projection.moderation = { user, action: data.action }
        kind = 'moderation'
        break
      }
      default:
        throw new Fault('invalid')
    }
    if (data.action !== 'close') touch(next, now)
    recordReceipt(next, data.actor.id, data.id)
    await this.commit(current, next, kind, { projection })
    await this.tick(now)
    return json({ ok: true })
  }

  async webSocketMessage(socket: WebSocket, payload: string | ArrayBuffer) {
    if (typeof payload !== 'string' || payload.length > 2048) {
      socket.close(1009, 'too_large')
      return
    }
    const now = Date.now()
    const traffic = this.traffic.get(socket) ?? { since: now, count: 0 }
    if (now - traffic.since > 5000) {
      traffic.since = now
      traffic.count = 0
    }
    traffic.count++
    this.traffic.set(socket, traffic)
    if (traffic.count > 22 || this.queued >= MAX_QUEUE) {
      socket.close(1008, 'rate_limit')
      return
    }
    await this.serial(async () => {
      let id = ''
      try {
        let raw: unknown
        try {
          raw = JSON.parse(payload)
          id = typeof object(raw).id === 'string' ? (object(raw).id as string) : ''
        } catch {
          throw new Fault('invalid')
        }
        const command = parseCommand(raw)
        await this.tick(Date.now())
        const envelope = (await this.load())!
        const state = envelope.current
        if (state.closedAt) throw new Fault('closed', 410)
        if (command.tableId !== state.id) throw new Fault('invalid')
        const info = this.info(socket)
        const access = await this.freshAccess(info, state.id, command.kind === 'snapshot')
        if (command.kind === 'snapshot') {
          this.send(
            socket,
            this.makeView(
              state,
              { ...info, actor: { ...info.actor, role: access.role } },
              'snapshot',
              { messages: state.chat },
            ),
          )
          return
        }
        const duplicate = receipt(state, info.actor.id, id)
        if (duplicate) {
          this.send(socket, duplicate)
          return
        }
        if (envelope.pending) throw new Fault('recovering', 503)
        await this.playerCommand(socket, state, info, access, command)
        const current = (await this.load())!.current
        this.send(
          socket,
          receipt(current, info.actor.id, id) ?? {
            type: 'reply',
            id,
            ok: true,
            sequence: current.version,
          },
        )
        await this.tick(Date.now()).catch((error) => {
          if (!(error instanceof Fault && error.code === 'recovering')) {
            console.error(
              'Table deadline processing failed',
              error instanceof Error ? error.name : 'unknown',
            )
          }
        })
      } catch (error) {
        const code = error instanceof Fault ? error.code : 'unavailable'
        if (['session_expired', 'membership', 'banned', 'suspended'].includes(code)) {
          socket.close(code === 'session_expired' ? 4001 : 4003, code)
          return
        }
        this.send(socket, {
          type: 'reply',
          id: id.slice(0, 36),
          ok: false,
          error: code,
          sequence: (await this.load())?.current.version ?? 0,
        })
      }
    })
  }

  private async playerCommand(
    socket: WebSocket,
    current: TableState,
    info: SocketInfo,
    access: Access,
    command: Command,
  ) {
    const actor = info.actor.id
    const now = Date.now()
    if (command.kind === 'take_control') {
      for (const ws of this.ctx.getWebSockets('user:' + actor)) {
        const previous = this.info(ws)
        ws.serializeAttachment({ ...previous, controller: ws === socket })
      }
      this.publish(current, 'control')
      return
    }
    if (!info.controller) throw new Fault('read_only', 409)
    if (current.closing && !['action', 'clear', 'chat', 'reaction'].includes(command.kind))
      throw new Fault('closed', 409)
    if (command.kind === 'reaction') {
      if (!current.settings.chat || access.muted) throw new Fault('muted', 403)
      const last = this.announcements.get(actor) ?? 0
      if (now - last < 2500) throw new Fault('rate_limit', 429)
      if (this.announcements.size > 80)
        for (const [key, at] of this.announcements)
          if (now - at > 2500) this.announcements.delete(key)
      this.announcements.set(actor, now)
      this.publish(current, 'reaction', {
        reaction: { name: access.name, user: actor, value: command.value },
      })
      return
    }
    const next = structuredClone(current)
    const seat = next.seats.find((entry) => entry.user === actor)
    const round = next.round
    const cues = framesFor(next, now)
    let kind: EventKind
    let entry: Entry | undefined
    if (
      'roundId' in command &&
      (command.roundId !== round?.id || (round.deadline !== undefined && now >= round.deadline))
    )
      throw new Fault('stale', 409)
    switch (command.kind) {
      case 'seat': {
        if (seat || next.paused || !this.seatWindow(next)) throw new Fault('illegal_action', 409)
        const position =
          next.settings.seats === 'first'
            ? Array.from({ length: next.settings.maxPlayers }, (_, index) => index).find(
                (index) => !next.seats.some((item) => item.position === index),
              )
            : command.position
        if (
          position === undefined ||
          position >= next.settings.maxPlayers ||
          next.seats.some((item) => item.position === position)
        )
          throw new Fault('seat_taken', 409)
        if (now - (this.announcements.get('seat:' + actor) ?? 0) < 3000)
          throw new Fault('rate_limit', 429)
        this.announcements.set('seat:' + actor, now)
        next.seats.push({
          user: actor,
          name: access.name,
          avatar: access.avatar,
          position,
          ready: false,
        })
        next.seats.sort((a, b) => a.position - b.position)
        kind = 'seat'
        break
      }
      case 'leave':
        if (!seat) throw new Fault('illegal_action', 409)
        if (round && activeRound(next) && round.players.some((player) => player.user === actor))
          throw new Fault('between_rounds', 409)
        next.seats = next.seats.filter((item) => item.user !== actor)
        kind = 'seat'
        break
      case 'ready':
        if (
          !seat ||
          seat.ready === command.value ||
          (activeRound(next) && round?.phase !== 'betting')
        )
          throw new Fault('illegal_action', 409)
        if (now - (this.announcements.get('ready:' + actor) ?? 0) < 3000)
          throw new Fault('rate_limit', 429)
        this.announcements.set('ready:' + actor, now)
        seat.ready = command.value
        kind = 'ready'
        break
      case 'bet':
      case 'clear':
      case 'action': {
        if (!round || !seat || seat.retire || next.paused) throw new Fault('illegal_action', 409)
        if (current.roundReceipts.filter((item) => item.user === actor).length >= 160)
          throw new Fault('rate_limit', 429)
        let delta = 0
        let ledgerKind: Entry['kind'] = 'bet'
        if (command.kind === 'bet') {
          if (command.chips < next.settings.minBet || command.chips > next.settings.maxBet)
            throw new Fault('bet_limits', 409)
          delta = -command.chips * UNIT
          bet(round, actor, seat.position, -delta)
          kind = 'bet'
        } else if (command.kind === 'clear') {
          delta = clearBet(round, actor)
          ledgerKind = 'clear'
          kind = 'refund'
        } else {
          if (
            round.phase === 'playing' &&
            (round.turn?.step !== command.step || round.turn?.hand !== command.hand)
          )
            throw new Fault('stale', 409)
          const cost = actionCost(round, actor, command.action)
          delta = -cost
          ledgerKind =
            command.action === 'insure'
              ? 'insurance'
              : command.action === 'double'
                ? 'double'
                : 'split'
          act(round, next.shoe!, actor, command.action, now, cues.emit)
          kind = command.action
        }
        if (delta)
          entry = {
            id: 'op:' + current.id + ':' + round.id + ':' + actor + ':' + command.id,
            user: actor,
            table: next.id,
            round: round.id,
            delta,
            kind: ledgerKind,
            at: now,
          }
        break
      }
      case 'chat': {
        if (!next.settings.chat || access.muted) throw new Fault('muted', 403)
        const last = next.chat.findLast((message) => message.author === actor)
        if (
          last?.id === command.id ||
          next.chat.some((message) => message.id === command.id && message.author === actor)
        )
          return
        if (last && now - last.at < 1800) throw new Fault('rate_limit', 429)
        const message = {
          id: command.id,
          author: actor,
          name: access.name,
          avatar: access.avatar,
          text: command.text,
          at: now,
        }
        next.chat.push(message)
        next.chat = next.chat.filter((message) => message.at > now - CHAT_RETENTION).slice(-60)
        next.version = current.version + 1
        await this.save({ current: next })
        this.publish(next, 'chat', { messages: [message] })
        return
      }
      default:
        throw new Fault('invalid')
    }
    const isRound = 'roundId' in command
    if (isRound) touch(next, now)
    if (command.kind === 'seat' || (command.kind === 'ready' && command.value)) {
      const participation = command.kind + ':' + actor
      if (!next.lobbyTouches.includes(participation)) {
        if (next.lobbyTouches.length < 256) next.lobbyTouches.push(participation)
        touch(next, now)
      }
    }
    recordReceipt(next, actor, command.id, undefined, isRound)
    await this.commit(current, next, kind, {
      entry,
      command: command.id,
      actor,
      visuals: cues.visuals,
    })
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    await this.serial(async () => {
      const info = this.info(socket)
      if (!info) return
      this.access.delete(info.id)
      try {
        socket.close(code === 1006 ? 1011 : code === 1005 ? 1000 : code, reason)
      } catch {
        /* Runtime may already acknowledge. */
      }
      const envelope = await this.load()
      if (!envelope || envelope.current.closedAt) return
      const current = envelope.current
      if (
        !this.connected().has(info.actor.id) &&
        !envelope.pending &&
        current.seats.some((seat) => seat.user === info.actor.id)
      ) {
        const next = structuredClone(current)
        next.seats.find((seat) => seat.user === info.actor.id)!.offlineAt = Date.now()
        await this.save({ current: next })
        this.publish(next, 'disconnected')
      } else {
        this.publish(current, 'disconnected')
      }
    })
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1011, 'unavailable')
  }
}
