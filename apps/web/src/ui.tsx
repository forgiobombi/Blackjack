import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Avatar, Card } from '../../../packages/protocol/types.ts'
import type { T } from './i18n.ts'

const paths: Record<string, ReactNode> = {
  arrow: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  back: (
    <>
      <path d="M20 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path d="M11 11l7-7 3 3-2 2-1-1-2 2 1 1-3 3" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m2 3a4 4 0 0 1 3 4v1" />
    </>
  ),
  cards: (
    <>
      <rect x="7" y="4" width="11" height="16" rx="2" transform="rotate(12 12 12)" />
      <path d="M5 17 3 8a2 2 0 0 1 2-2m7 3 2 3-2 3-2-3z" />
    </>
  ),
  chip: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 3v4m9 5h-4m-5 9v-4m-9-5h4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  shield: (
    <>
      <path d="M12 3 4 6v5c0 5 3 8 8 10 5-2 8-5 8-10V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2-4a8.5 8.5 0 1 1 15-4.5Z" />,
  sound: (
    <>
      <path d="m11 5-5 4H3v6h3l5 4V5Z" />
      <path d="M15 9a4 4 0 0 1 0 6m3-9a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  muted: (
    <>
      <path d="m11 5-5 4H3v6h3l5 4V5Z" />
      <path d="m16 9 5 6m0-6-5 6" />
    </>
  ),
  close: <path d="m6 6 12 12m0-12L6 18" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  expand: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3Z" />
    </>
  ),
  spark: <path d="M12 2v5m0 10v5M2 12h5m10 0h5m-3-7-4 4m-6 6-4 4m0-14 4 4m6 6 4 4" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3" />
    </>
  ),
  chart: (
    <>
      <path d="M4 3v17h17M8 16v-4m5 4V7m5 9v-6" />
    </>
  ),
  flag: <path d="M5 21V4c4-3 8 3 13 0v10c-5 3-9-3-13 0" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M15 4H6a2 2 0 0 0-2 2v9" />
    </>
  ),
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.spark}
    </svg>
  )
}

export const SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' }
const AVATAR_GLYPHS: Record<Avatar, string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
  moon: '☾',
  star: '✦',
}

export function AvatarIcon({
  avatar = 'spade',
  className = '',
}: {
  avatar?: Avatar
  className?: string
}) {
  return (
    <span className={'avatar avatar-' + avatar + ' ' + className} aria-hidden="true">
      {AVATAR_GLYPHS[avatar]}
    </span>
  )
}

export function PlayingCard({
  card,
  t,
  index = 0,
  staticCard = false,
}: {
  card: Card | null
  t: T
  index?: number
  staticCard?: boolean
}) {
  const label = card
    ? t('cardLabel', {
        rank: ['A', 'J', 'Q', 'K'].includes(card.rank) ? t(card.rank) : card.rank,
        suit: t(card.suit),
      })
    : t('hidden')
  return (
    <span
      className={
        'playing-card' +
        (!card ? ' card-back' : ['H', 'D'].includes(card.suit) ? ' suit-red' : '') +
        (staticCard ? ' card-static' : '')
      }
      role="img"
      aria-label={label}
      style={{ animationDelay: Math.min(index, 6) * 58 + 'ms' }}
    >
      {card ? (
        <>
          <span className="card-corner">
            <b>{card.rank}</b>
            <span>{SYMBOLS[card.suit]}</span>
          </span>
          <span className="card-suit">{SYMBOLS[card.suit]}</span>
          <span className="card-corner reverse">
            <b>{card.rank}</b>
            <span>{SYMBOLS[card.suit]}</span>
          </span>
        </>
      ) : (
        <span>♠</span>
      )}
    </span>
  )
}

export function Modal({
  title,
  children,
  close,
  t,
}: {
  title: string
  children: ReactNode
  close: () => void
  t: T
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClick={(e) => {
        if (e.target === ref.current) close()
      }}
    >
      <div className="dialog-body">
        <div className="section-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" aria-label={t('close')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

export function Notice({ error, text }: { error?: boolean; text: string }) {
  return (
    <div className={'notice' + (error ? ' notice-error' : '')} role={error ? 'alert' : 'status'}>
      {text}
    </div>
  )
}

export function PageTitle({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children?: ReactNode
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="page-title-actions">{children}</div>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}
