import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  Action,
  EventKind,
  PlayerCommand,
  Profile,
  View,
} from '../../../packages/protocol/types.ts'
import { api, codeOf } from './api.ts'
import { cue, music, unlock } from './audio.ts'
import { Board, HandCards } from './board.tsx'
import { TableChat } from './chat.tsx'
import { chipCount } from './i18n.ts'
import { RulesList } from './public.tsx'
import { useTableSocket } from './socket.ts'
import { useApp } from './state.tsx'
import { Icon, Modal, Notice } from './ui.tsx'
import './table.css'

const Invitations = lazy(() => import('./invitations.tsx'))
const DENOMINATIONS = [5, 10, 25, 100, 500, 1000]
const SHORTCUTS: Record<string, Action> = { h: 'hit', s: 'stand', d: 'double', p: 'split' }
const effects = new Set<EventKind>([
  'shuffle',
  'deal',
  'hit',
  'double',
  'split',
  'turn',
  'reveal',
  'dealerHit',
  'settled',
  'bet',
  'refund',
  'betting',
  'warning',
  'chat',
])

function useClock(view?: View) {
  const [now, setNow] = useState(Date.now)
  const serverOffset = useRef(0)
  useEffect(() => {
    if (view) {
      serverOffset.current = view.serverTime - Date.now()
      setNow(view.serverTime)
    }
  }, [view])
  useEffect(() => {
    if (!(view?.deadline || view?.warning)) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now() + serverOffset.current)
    }, 240)
    return () => window.clearInterval(timer)
  }, [Boolean(view?.deadline || view?.warning)])
  return now
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

function connectionCaption(view: View, mine: string, t: ReturnType<typeof useApp>['t']) {
  if (view.paused) return t('paused')
  if (view.recovering) return t('recovering')
  if (view.phase === 'closed') return t(view.reason === 'idle' ? 'idleClosed' : 'closed')
  if (view.turn)
    return view.turn.user === mine
      ? t('yourTurn')
      : t('otherTurn', {
          name: view.seats.find((seat) => seat.id === view.turn?.user)?.name ?? t('player'),
        })
  return t(view.phase === 'settling' ? 'dealerTurn' : view.phase)
}

export default function Game({ id }: { id: string }) {
  const { t, me, setMe, locale, toast } = useApp()
  const session = useTableSocket(id, me!.id)
  const view = session.view
  const now = useClock(view)
  const mine = view?.seats.find((seat) => seat.id === me!.id)
  const [bet, setBet] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'rules' | 'invite' | 'close' | null>(null)
  const [chat, setChat] = useState(
    me!.preferences.chat && matchMedia('(min-width: 1060px)').matches,
  )
  const [visual, setVisual] = useState<{ kind: EventKind; target?: number; stamp: number }>()
  const [reaction, setReaction] = useState<View['reaction']>()
  const [hidden, setHidden] = useState(document.hidden)
  const pref = me!.preferences
  const root = useRef<HTMLElement>(null)
  const previousEffect = useRef(0)

  useEffect(() => setBet(''), [view?.roundId])
  useEffect(() => {
    const visibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    if (!pref.audio || !pref.music || hidden) return
    music(pref)
    const timer = window.setInterval(() => music(pref), 5000)
    return () => window.clearInterval(timer)
  }, [pref, hidden])
  useEffect(() => {
    if (!view || view.sequence === previousEffect.current) return
    previousEffect.current = view.sequence
    const latest = view.visuals
      ?.filter((event) =>
        ['deal', 'hit', 'split', 'double', 'dealerHit', 'shuffle', 'reveal', 'settled'].includes(
          event.kind,
        ),
      )
      .at(-1)
    if (latest || effects.has(view.kind)) {
      const event = latest?.kind ?? view.kind
      const result = view.seats.find((seat) => seat.id === me!.id)?.hands
      const announcement =
        view.kind === 'settled' && result?.some((hand) => hand.result === 'blackjack')
          ? 'premium'
          : view.kind === 'settled' &&
              result?.every((hand) => ['loss', 'bust', 'surrender'].includes(hand.result ?? ''))
            ? 'loss'
            : view.kind === 'settled' && result?.every((hand) => hand.result === 'push')
              ? 'push'
              : event
      if (pref.notifications || !['turn', 'warning', 'chat'].includes(event))
        cue(announcement, pref)
      setVisual({ kind: event, target: latest?.target ?? view.target, stamp: view.sequence })
    }
  }, [view, me!.id, pref])
  useEffect(() => {
    if (!view?.reaction) return
    setReaction(view.reaction)
    const timer = window.setTimeout(() => setReaction(undefined), 2300)
    return () => window.clearTimeout(timer)
  }, [view?.reaction])
  useEffect(() => {
    if (!view || view.wallet === undefined || view.wallet === me!.balance) return
    setMe({ ...me!, balance: view.wallet })
  }, [view?.wallet])

  async function action(command: PlayerCommand) {
    if (busy) return
    await unlock()
    setBusy(true)
    setError('')
    try {
      await session.send(command)
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  function play(value: Action) {
    if (!view?.roundId || !view.actions.includes(value)) return
    void action({
      kind: 'action',
      action: value,
      roundId: view.roundId,
      step: view.turn?.step,
      hand: view.turn?.hand,
    })
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        dialog ||
        busy ||
        session.connection !== 'online'
      )
        return
      const element = event.target
      if (
        element instanceof HTMLElement &&
        (element.closest('input, textarea, select, button, a, dialog') || element.isContentEditable)
      )
        return
      const value = SHORTCUTS[event.key.toLowerCase()]
      if (value && view?.actions.includes(value)) {
        event.preventDefault()
        play(value)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  async function host(value: string, enabled?: number) {
    setError('')
    try {
      await api('/tables/' + id + '/admin', {
        body: { action: value, enabled, id: crypto.randomUUID() },
      })
      if (value === 'close') {
        setDialog(null)
        toast(t('closingRequested'))
      }
    } catch (e) {
      setError(codeOf(e))
    }
  }
  async function sound() {
    await unlock()
    const preferences = { ...pref, audio: !pref.audio }
    setMe({ ...me!, preferences })
    if (preferences.audio) cue('click', preferences)
    try {
      const updated = await api<Profile>('/me/preferences', { method: 'PATCH', body: preferences })
      // The on-table wallet can have changed while the settings request was in flight.
      setMe({ ...updated, balance: view?.wallet ?? updated.balance })
    } catch (e) {
      setError(codeOf(e))
    }
  }
  function confirmBet(event: FormEvent) {
    event.preventDefault()
    if (view?.roundId) void action({ kind: 'bet', chips: Number(bet), roundId: view.roundId })
  }

  if (!view)
    return (
      <main id="main-content" className="content-width page">
        <a className="button button-ghost" href="#/lobby">
          <Icon name="back" />
          {t('lobby')}
        </a>
        {session.error ? (
          <>
            <Notice error text={t(session.error)} />
            {session.connection !== 'closed' && (
              <button className="button button-outline" onClick={session.reconnect}>
                {t('retry')}
              </button>
            )}
          </>
        ) : (
          <p role="status">{t(session.connection)}</p>
        )}
      </main>
    )

  const phase = view.phase
  const own = view.turn?.user === me!.id
  const activeRound = !['waiting', 'complete', 'closed'].includes(phase)
  const enable = session.connection === 'online' && !view.recovering && !busy
  const terminal = phase === 'closed' || session.connection === 'closed'
  const settings = pref.theme === 'table' ? view.settings : { ...view.settings, theme: pref.theme }
  const caption = connectionCaption(view, me!.id, t)
  const actions = view.actions
  const amount = Number(bet)
  const canBet =
    enable &&
    view.controller &&
    amount >= view.settings.minBet &&
    amount <= view.settings.maxBet &&
    amount * 10 <= (view.wallet ?? 0)
  const fittingChips = DENOMINATIONS.filter((denomination) => denomination <= view.settings.maxBet)
  const denominations = [...new Set([view.settings.minBet, ...fittingChips])].sort((a, b) => a - b)
  const motion =
    hidden || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'minimal' : pref.motion
  return (
    <main
      id="main-content"
      className={'content-width play-page motion-' + motion + ' density-' + pref.density}
      data-speed={pref.animationSpeed === 'fast' || settings.speed === 'fast' ? 'fast' : 'normal'}
      data-cards={pref.cards}
      data-chips={pref.chips}
      ref={root}
    >
      <div className="game-heading">
        <div>
          <a className="back-link" href="#/lobby">
            <Icon name="back" size={16} />
            {t('lobby')}
          </a>
          <h1>{view.settings.name}</h1>
          <div className="game-rule-row">
            <span>{view.settings.rules.payout}</span>
            <span>{view.settings.rules.soft17 === 'stand' ? 'S17' : 'H17'}</span>
            <span>
              {view.settings.rules.decks} {t('decks').toLowerCase()}
            </span>
            <span>
              <Icon name="people" size={14} />
              {view.spectators} {t('spectators').toLowerCase()}
            </span>
          </div>
        </div>
        <div className="game-tools">
          <span
            className="wallet-chip"
            role="status"
            aria-label={t('yourBalance') + ' ' + chipCount(view.wallet ?? me!.balance, locale)}
          >
            <Icon name="chip" />
            <b>{chipCount(view.wallet ?? me!.balance, locale)}</b>
          </span>
          {view.settings.chat && (
            <button
              className="icon-button"
              aria-label={t('chat')}
              aria-pressed={chat}
              onClick={() => setChat(!chat)}
            >
              <Icon name="chat" />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={t(pref.audio ? 'audioOff' : 'audioOn')}
            aria-pressed={pref.audio}
            onClick={() => void sound()}
          >
            <Icon name={pref.audio ? 'sound' : 'muted'} />
          </button>
          <button
            className="icon-button"
            aria-label={t('cityRules')}
            onClick={() => setDialog('rules')}
          >
            <Icon name="settings" />
          </button>
          {document.fullscreenEnabled && (
            <button
              className="icon-button full-button"
              aria-label={t('fullscreen')}
              onClick={() =>
                void (
                  document.fullscreenElement
                    ? document.exitFullscreen()
                    : root.current?.requestFullscreen()
                )?.catch(() => setError('browserUnsupported'))
              }
            >
              <Icon name="expand" />
            </button>
          )}
        </div>
      </div>
      {error && <Notice error text={t(error)} />}
      {session.connection === 'reconnecting' && <Notice text={t('reconnecting')} />}
      {view.recovering && <Notice text={t('recovering')} />}
      {view.closing && !terminal && <Notice text={t('closingAfter')} />}
      {view.warning > 0 && !view.closing && !terminal && (
        <Notice
          error={view.warning === 2}
          text={t('idleWarning', { time: duration(view.idleAt - now) })}
        />
      )}
      {session.error && session.connection === 'closed' && phase !== 'closed' && (
        <Notice error text={t(session.error)} />
      )}
      {!view.controller && !terminal && (
        <div className="control-banner">
          <span>{t('read_only')}</span>
          <button
            className="button button-outline"
            disabled={!enable}
            onClick={() => void action({ kind: 'take_control' })}
          >
            {t('takeControl')}
          </button>
        </div>
      )}
      <div className={'game-layout' + (chat && view.settings.chat ? ' with-chat' : '')}>
        <div className="game-column">
          <div className="game-status">
            <span role="status" className={own ? 'your-turn' : ''}>
              <span className={'status-dot ' + (terminal ? 'status-off' : '')}></span>
              {caption}
            </span>
            {view.deadline && !terminal && (
              <span
                className={'table-clock' + (view.deadline - now < 5000 ? ' urgent' : '')}
                role="timer"
                aria-label={t('tableTimeout')}
              >
                <Icon name="clock" size={17} />
                {duration(view.deadline - now)}
              </span>
            )}
          </div>
          <Board
            frame={view}
            settings={settings}
            local={me!.id}
            seating={!terminal && enable && view.canSeat && view.controller}
            onSeat={(position) => void action({ kind: 'seat', position })}
            cue={visual?.kind}
            cueTarget={visual?.target}
            cueStamp={visual?.stamp}
            reaction={reaction}
            paused={view.paused}
          />
          <section className="game-console panel">
            <div className="personal-hand">
              <div className="section-head">
                <h2>{t(mine ? 'yourHand' : 'spectators')}</h2>
                {mine?.bet ? (
                  <span className="badge">
                    <Icon name="chip" size={15} />
                    {chipCount(mine.bet, locale)}
                  </span>
                ) : null}
              </div>
              {mine?.hands.length ? (
                <div className="my-hands">
                  {mine.hands.map((hand, n) => (
                    <HandCards
                      key={hand.id}
                      hand={hand}
                      index={mine.hands.length > 1 ? n : undefined}
                      active={own && view.turn?.hand === hand.id}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">
                  {t(
                    terminal
                      ? view.reason === 'idle'
                        ? 'idleClosed'
                        : 'closed'
                      : mine
                        ? 'noCards'
                        : view.canSeat
                          ? 'readyPrompt'
                          : 'spectatorPrompt',
                  )}
                </p>
              )}
              {!!mine?.insurance && (
                <p className="insurance-note">
                  {t('insurance')} · {chipCount(mine.insurance, locale)}
                  {mine.insuranceReturned !== undefined &&
                    ' · ' + t('returned', { n: chipCount(mine.insuranceReturned, locale) })}
                </p>
              )}
            </div>
            <div className="round-controls">
              {!terminal && phase === 'betting' && mine && !mine.bet && view.controller && (
                <form className="bet-form" onSubmit={confirmBet}>
                  <div className="section-head">
                    <h2>{t('bet')}</h2>
                    <span className="muted">
                      {t('betRange', { min: view.settings.minBet, max: view.settings.maxBet })}
                    </span>
                  </div>
                  <div className="chip-select">
                    {denominations.map((value, index) => (
                      <button
                        type="button"
                        key={value}
                        className={'chip-denom chip-' + (index % 6)}
                        aria-label={t('bet') + ' +' + value}
                        disabled={
                          !enable ||
                          value + amount > view.settings.maxBet ||
                          (value + amount) * 10 > (view.wallet ?? 0)
                        }
                        onClick={() => {
                          cue('bet', pref)
                          setBet(String(amount + value))
                        }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <div className="bet-input">
                    <label className="sr-only" htmlFor="bet-amount">
                      {t('betAmount')}
                    </label>
                    <input
                      id="bet-amount"
                      type="number"
                      min={view.settings.minBet}
                      max={view.settings.maxBet}
                      step="1"
                      placeholder={String(view.settings.minBet)}
                      value={bet}
                      onChange={(event) => setBet(event.target.value)}
                      required
                    />
                    <button className="button button-primary" disabled={!canBet}>
                      {t('confirmBet')}
                    </button>
                  </div>
                </form>
              )}
              {!terminal && phase === 'betting' && !!mine?.bet && (
                <div className="button-row">
                  <span className="badge">{t('betLocked')}</span>
                  <button
                    className="button button-outline"
                    disabled={!enable || !view.controller}
                    onClick={() => void action({ kind: 'clear', roundId: view.roundId! })}
                  >
                    {t('clearBet')}
                  </button>
                </div>
              )}
              {!terminal && actions.length > 0 && (
                <div className="stack">
                  <h2>
                    {t(
                      phase === 'insurance'
                        ? 'insurance'
                        : phase === 'early'
                          ? 'early'
                          : 'actionPrompt',
                    )}
                  </h2>
                  <div className="action-grid">
                    {actions.map((choice) => (
                      <button
                        className={
                          'button ' +
                          (choice === 'hit' || choice === 'insure'
                            ? 'button-primary'
                            : 'button-outline')
                        }
                        key={choice}
                        disabled={!enable}
                        onClick={() => play(choice)}
                        aria-keyshortcuts={Object.keys(SHORTCUTS)
                          .find((key) => SHORTCUTS[key] === choice)
                          ?.toUpperCase()}
                      >
                        {t(choice)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!terminal && mine && !activeRound && (
                <div className="button-row">
                  <button
                    className={'button ' + (mine.ready ? 'button-outline' : 'button-primary')}
                    disabled={!enable || !view.controller || view.paused}
                    onClick={() => void action({ kind: 'ready', value: !mine.ready })}
                  >
                    {t(mine.ready ? 'notReady' : 'ready')}
                  </button>
                  <button
                    className="button button-ghost"
                    disabled={!enable || !view.controller}
                    onClick={() => void action({ kind: 'leave' })}
                  >
                    {t('leaveSeat')}
                  </button>
                </div>
              )}
              {!terminal && mine && phase === 'playing' && !own && actions.length === 0 && (
                <p className="muted">{t('waitTurn')}</p>
              )}
              {terminal && (
                <a className="button button-primary" href="#/lobby">
                  <Icon name="back" size={18} />
                  {t('lobby')}
                </a>
              )}
            </div>
          </section>
          {!terminal && (
            <div className="table-host-actions button-row">
              {(view.owner || view.settings.friendInvites) && !view.closing && view.joinEnabled && (
                <button className="button button-outline" onClick={() => setDialog('invite')}>
                  <Icon name="key" size={17} />
                  {t('inviteFriends')}
                </button>
              )}
              {view.owner && (
                <>
                  <button
                    className="button button-primary"
                    disabled={
                      activeRound || view.paused || view.closing || !enable || !view.seats.length
                    }
                    onClick={() => void host('start')}
                  >
                    {t(phase === 'complete' ? 'nextRound' : 'startRound')}
                  </button>
                  <button
                    className="button button-outline"
                    disabled={activeRound || view.closing || !enable}
                    onClick={() => void host(view.paused ? 'resume' : 'pause')}
                  >
                    {t(view.paused ? 'resume' : 'pause')}
                  </button>
                  <a className="button button-ghost" href={'#/admin/table/' + id}>
                    {t('details')}
                  </a>
                  <button
                    className="button button-ghost"
                    disabled={view.closing || !enable}
                    onClick={() => setDialog('close')}
                  >
                    {t('closeTable')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {chat && view.settings.chat && (
          <TableChat
            id={id}
            messages={session.messages}
            canSend={!terminal && view.controller && session.connection === 'online'}
            send={session.send}
            close={() => setChat(false)}
          />
        )}
      </div>
      {dialog === 'rules' && (
        <Modal title={t('cityRules')} t={t} close={() => setDialog(null)}>
          <RulesList settings={view.settings} />
        </Modal>
      )}
      {dialog === 'close' && (
        <Modal title={t('closeTable')} t={t} close={() => setDialog(null)}>
          <p>{t('closeConfirm')}</p>
          <div className="button-row">
            <button className="button button-outline" onClick={() => setDialog(null)}>
              {t('cancel')}
            </button>
            <button className="button button-primary" onClick={() => void host('close')}>
              {t('closeTable')}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'invite' && (
        <Suspense fallback={<span role="status">{t('loading')}</span>}>
          <Invitations id={id} owner={view.owner} close={() => setDialog(null)} />
        </Suspense>
      )}
    </main>
  )
}
