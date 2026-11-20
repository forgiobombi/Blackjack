import type { TableSettings, Theme } from './rules.ts'

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
export const SUITS = ['S', 'H', 'D', 'C'] as const
export type Card = { id: number; rank: (typeof RANKS)[number]; suit: (typeof SUITS)[number] }
export type Role = 'player' | 'admin' | 'superadmin'
export type Locale = 'en' | 'it'
export const AVATARS = ['spade', 'heart', 'club', 'diamond', 'moon', 'star'] as const
export type Avatar = (typeof AVATARS)[number]

export const ACTIONS = [
  'hit',
  'stand',
  'double',
  'split',
  'surrender',
  'decline',
  'insure',
] as const
export type Action = (typeof ACTIONS)[number]
export type Result = 'blackjack' | 'win' | 'loss' | 'bust' | 'push' | 'surrender' | 'refund'
export type Phase =
  'waiting' | 'betting' | 'early' | 'insurance' | 'playing' | 'settling' | 'complete' | 'closed'
export type PublicHand = {
  id: number
  cards: Card[]
  total: number
  soft: boolean
  stake: number
  result?: Result
  returned?: number
}
export type SeatView = {
  position: number
  id: string
  name: string
  avatar: Avatar
  ready: boolean
  connected: boolean
  bet: number
  hands: PublicHand[]
  insurance?: number
  insuranceReturned?: number
  balance?: number
}
export type ChatMessage = {
  id: string
  author: string
  name: string
  avatar: Avatar
  text: string
  at: number
}
export const REACTIONS = ['nice', 'blackjack', 'unlucky', 'gg', 'more', 'wow'] as const
export type Reaction = (typeof REACTIONS)[number]
export type EventKind =
  | 'snapshot'
  | 'connected'
  | 'disconnected'
  | 'seat'
  | 'ready'
  | 'betting'
  | 'bet'
  | 'refund'
  | 'shuffle'
  | 'deal'
  | 'early'
  | 'insurance'
  | 'turn'
  | Action
  | 'reveal'
  | 'dealerHit'
  | 'settled'
  | 'pause'
  | 'resume'
  | 'warning'
  | 'closing'
  | 'closed'
  | 'chat'
  | 'reaction'
  | 'settings'
  | 'moderation'
  | 'control'
  | 'recovering'

export type Frame = {
  kind: EventKind
  at: number
  phase: Phase
  dealer: (Card | null)[]
  dealerTotal: number
  seats: SeatView[]
  turn?: { user: string; hand: number; step: number }
  roundId?: string
  target?: number
  reason?: 'admin' | 'idle'
  shoe?: boolean
}

export type View = Frame & {
  type: 'state'
  sequence: number
  tableId: string
  settings: TableSettings
  serverTime: number
  owner: boolean
  controller: boolean
  joined: boolean
  canSeat: boolean
  actions: Action[]
  wallet?: number
  deadline?: number
  idleAt: number
  warning: number
  paused: boolean
  joinEnabled: boolean
  closing: boolean
  recovering: boolean
  spectators: number
  messages?: ChatMessage[]
  visuals?: Frame[]
  reaction?: { name: string; user: string; value: Reaction }
}

export type PlayerCommand =
  | { kind: 'snapshot' | 'take_control' }
  | { kind: 'seat'; position: number }
  | { kind: 'leave' }
  | { kind: 'ready'; value: boolean }
  | { kind: 'bet'; roundId: string; chips: number }
  | { kind: 'clear'; roundId: string }
  | { kind: 'action'; roundId: string; action: Action; step?: number; hand?: number }
  | { kind: 'chat'; text: string }
  | { kind: 'reaction'; value: Reaction }

export type Command = PlayerCommand & { id: string; tableId: string }
export type Reply = { type: 'reply'; id: string; ok: boolean; error?: string; sequence: number }
export type SocketMessage = View | Reply

export type TableSummary = {
  id: string
  ownerId: string
  settings: TableSettings
  status: 'open' | 'closing' | 'closed'
  createdAt: number
}
export type Preferences = {
  locale: Locale
  motion: 'high' | 'balanced' | 'minimal'
  animationSpeed: 'normal' | 'fast'
  audio: boolean
  volume: number
  effects: number
  music: number
  chat: boolean
  notifications: boolean
  cards: 'ivory' | 'midnight'
  chips: 'classic' | 'plain'
  density: 'cozy' | 'compact'
  theme: Theme | 'table'
}

export type Profile = {
  id: string
  username: string
  displayName: string
  avatar: Avatar
  role: Role
  createdAt: number
  balance: number
  refillAt: number
  preferences: Preferences
  privateStats: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  locale: 'en',
  motion: 'balanced',
  animationSpeed: 'normal',
  audio: false,
  volume: 0.6,
  effects: 0.7,
  music: 0,
  chat: true,
  notifications: true,
  cards: 'ivory',
  chips: 'classic',
  density: 'cozy',
  theme: 'table',
}

export type Stats = {
  rounds: number
  wins: number
  losses: number
  pushes: number
  blackjacks: number
  streak: number
  longest: number
  doubleWins: number
  splitWins: number
  social: number
}

export type RoundSummary = {
  id: string
  tableName: string
  at: number
  delta: number
  outcome: string
  hands: PublicHand[]
  dealer: Card[]
  settings: TableSettings
}
