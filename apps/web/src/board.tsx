import './table.css'
import type { CSSProperties } from 'react'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import type { Frame, PublicHand, SeatView } from '../../../packages/protocol/types.ts'
import { chipCount } from './i18n.ts'
import { useApp } from './state.tsx'
import { AvatarIcon, Icon, PlayingCard } from './ui.tsx'

export function HandCards({
  hand,
  active = false,
  small = false,
  index,
}: {
  hand: PublicHand
  active?: boolean
  small?: boolean
  index?: number
}) {
  const { t, locale } = useApp()
  return (
    <div className={'hand' + (small ? ' hand-small' : '') + (active ? ' hand-current' : '')}>
      {index !== undefined && (
        <div className="hand-name">
          {t('hand', { n: index + 1 })}
          {active && <span className="sr-only"> {t('activeHand')}</span>}
        </div>
      )}
      <div className="card-pile">
        {hand.cards.map((card, position) => (
          <PlayingCard key={card.id} card={card} index={position} t={t} />
        ))}
      </div>
      <div className="hand-meta">
        {hand.cards.length > 0 && (
          <span title={t('handTotal', { n: hand.total })}>
            {hand.total}
            {hand.soft ? ' · ' + t('soft') : ''}
          </span>
        )}
        {hand.result && (
          <strong className={'result result-' + hand.result}>
            {t(hand.result === 'surrender' ? 'surrenderResult' : hand.result)}
          </strong>
        )}
      </div>
      {hand.returned !== undefined && hand.returned > 0 && !small && (
        <div className="hand-return">
          <Icon name="chip" size={14} />
          {t('returned', { n: chipCount(hand.returned, locale) })}
        </div>
      )}
    </div>
  )
}

function position(index: number, count: number) {
  if (count === 1) return { '--seat-x': '50%', '--seat-y': '74%' } as CSSProperties
  const angle = Math.PI * (0.12 + (0.76 * index) / (count - 1))
  return {
    '--seat-x': 50 - 45.5 * Math.cos(angle) + '%',
    '--seat-y': 7 + 67 * Math.sin(angle) + '%',
  } as CSSProperties
}

type BoardProps = {
  frame: Frame
  settings: TableSettings
  local?: string
  seating?: boolean
  onSeat?: (position: number) => void
  cue?: string
  cueTarget?: number
  cueStamp?: number
  reaction?: { user: string; value: string }
  paused?: boolean
  replay?: boolean
}
export function Board({
  frame,
  settings,
  local,
  seating,
  onSeat,
  cue,
  cueTarget,
  cueStamp,
  reaction,
  paused,
  replay,
}: BoardProps) {
  const { t, locale } = useApp()
  const players = Array.from({ length: settings.maxPlayers }, (_, index) =>
    frame.seats.find((seat) => seat.position === index),
  )
  const player = frame.seats.find((seat) => seat.id === local)
  const dealerCue = paused ? 'pause' : (cue ?? frame.kind)
  const results = player?.hands ?? []
  const returned = results.reduce(
    (sum, hand) => sum + (hand.returned ?? 0),
    player?.insuranceReturned ?? 0,
  )
  const chipEffect =
    frame.phase !== 'complete'
      ? 'bet'
      : results.some((hand) => hand.result === 'blackjack')
        ? 'blackjack'
        : returned > 0
          ? 'return'
          : 'collect'
  return (
    <div className={'casino-board theme-' + settings.theme} data-phase={frame.phase}>
      <div className="room-arch" aria-hidden="true"></div>
      <div
        className={'dealer-character dealer-' + dealerCue}
        key={dealerCue + ':' + (cueStamp ?? '')}
        style={
          {
            '--look':
              cueTarget === undefined
                ? '0deg'
                : (cueTarget - (settings.maxPlayers - 1) / 2) * 2 + 'deg',
          } as CSSProperties
        }
      >
        <div className="dealer-aura" aria-hidden="true"></div>
        <div className="dealer-portrait">
          <img src={import.meta.env.BASE_URL + 'dealer.webp'} alt="" width="496" height="420" />
          <i className="blink" aria-hidden="true"></i>
        </div>
      </div>
      <div className="felt-base" aria-hidden="true"></div>
      <div className="felt-markings" aria-hidden="true">
        <span>♠</span>
      </div>
      <div className="shoe" aria-hidden="true">
        <span>
          <b>♠</b>
        </span>
        <i></i>
      </div>
      <div className="discard-tray" aria-hidden="true">
        <span></span>
      </div>
      <div className="dealer-area">
        <span className="dealer-caption">
          {t('dealer')}
          {frame.dealerTotal > 0 && (
            <b className={frame.dealerTotal > 21 ? 'dealer-bust' : ''}>{frame.dealerTotal}</b>
          )}
        </span>
        {frame.dealer.length ? (
          <div className="card-pile dealer-cards">
            {frame.dealer.map((card, index) => (
              <PlayingCard key={card?.id ?? 'hidden'} card={card} t={t} index={index} />
            ))}
          </div>
        ) : (
          <div className="dealer-slots" aria-hidden="true">
            <span />
            <span />
          </div>
        )}
        {frame.dealerTotal > 21 && <small className="result result-bust">{t('dealerBust')}</small>}
      </div>
      <div className="seat-ring">
        {players.map((seat, index) => {
          const available = seating && !player && !seat && Boolean(onSeat)
          const isTurn = Boolean(seat && frame.turn?.user === seat.id)
          const item = seat ? (
            <Seat
              seat={seat}
              isTurn={isTurn}
              local={seat.id === local}
              reaction={reaction?.user === seat.id ? reaction?.value : undefined}
              replay={replay}
            />
          ) : (
            <>
              {available && settings.seats === 'choose' ? (
                <button
                  className="seat-open"
                  aria-label={t('takeSeat', { n: index + 1 })}
                  onClick={() => onSeat?.(index)}
                >
                  <Icon name="plus" size={20} />
                </button>
              ) : (
                <span className="seat-vacant" aria-hidden="true">
                  <Icon name="plus" size={16} />
                </span>
              )}
              <span className="seat-label">{t('chair', { n: index + 1 })}</span>
            </>
          )
          return (
            <div
              className={
                'seat-spot' +
                (seat ? ' occupied' : '') +
                (isTurn ? ' seat-current' : '') +
                (seat?.id === local && seat ? ' seat-local' : '')
              }
              key={index}
              style={position(index, settings.maxPlayers)}
            >
              {item}
            </div>
          )
        })}
      </div>
      {settings.seats === 'first' && seating && !player && players.some((seat) => !seat) && (
        <button
          type="button"
          className="button button-outline board-next-seat"
          onClick={() => onSeat?.(0)}
        >
          {t('firstSeat')}
        </button>
      )}
      {player && player.bet > 0 && (
        <div
          className={'bet-on-felt chips-' + chipEffect}
          key={player.bet + ':' + chipEffect}
          title={t('bet')}
        >
          <span>
            <Icon name="chip" size={16} />
          </span>
          <b>{chipCount(player.bet, locale)}</b>
        </div>
      )}
    </div>
  )
}

function Seat({
  seat,
  local,
  isTurn,
  reaction,
  replay,
}: {
  seat: SeatView
  local: boolean
  isTurn: boolean
  reaction?: string
  replay?: boolean
}) {
  const { t, locale } = useApp()
  return (
    <>
      {reaction && (
        <span className="seat-reaction" role="status">
          {t(reaction)}
        </span>
      )}
      <div className="seat-avatar">
        <AvatarIcon avatar={seat.avatar} />
        {!replay && (
          <span
            className={'presence-dot' + (seat.connected ? ' online' : '')}
            title={t(seat.connected ? 'online' : 'offline')}
          />
        )}
      </div>
      <div className="seat-label">
        <b>{local ? t('you') : seat.name}</b>
        {isTurn && <span className="sr-only"> {t('activeHand')}</span>}
      </div>
      <div className="seat-detail">
        {seat.bet > 0 ? (
          <span>
            <Icon name="chip" size={12} />
            {chipCount(seat.bet, locale)}
          </span>
        ) : (
          !replay && <span>{t(seat.ready ? 'ready' : 'notReady')}</span>
        )}
      </div>
      {(!local || replay) && seat.hands.length > 0 && (
        <div className="remote-hands">
          {seat.hands.map((hand) => (
            <HandCards key={hand.id} hand={hand} small active={isTurn} />
          ))}
        </div>
      )}
    </>
  )
}
