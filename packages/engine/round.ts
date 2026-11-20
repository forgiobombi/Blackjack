import { draw, cardValue, handValue, natural, EmptyShoe } from './cards.ts'
import type { Shoe } from './cards.ts'
import type { Rules } from '../protocol/rules.ts'
import type { Action, Card, EventKind, Result } from '../protocol/types.ts'
import { Fault } from '../protocol/validation.ts'

export type Hand = {
  id: number
  cards: Card[]
  stake: number
  original: number
  split: boolean
  splitAces: boolean
  doubled: boolean
  status: 'open' | 'stand' | 'bust' | 'natural' | 'surrender'
  early?: boolean
  result?: Result
  returned?: number
}

export type Participant = {
  user: string
  position: number
  bet: number
  hands: Hand[]
  earlyAnswered?: boolean
  insurance?: number
  insuranceReturned?: number
}

export type Round = {
  id: string
  phase: 'betting' | 'early' | 'insurance' | 'playing' | 'settling' | 'complete'
  players: Participant[]
  dealer: Card[]
  revealed: boolean
  rules: Rules
  seconds: number
  deadline?: number
  turn?: { user: string; hand: number; step: number }
  step: number
  nextHand: number
  cancelled: boolean
}
export type Emit = (kind: EventKind, target?: number) => void

export function openRound(
  id: string,
  now: number,
  rules: Rules,
  betting: number,
  turns: number,
): Round {
  return {
    id,
    rules: { ...rules },
    seconds: turns,
    phase: 'betting',
    deadline: now + betting * 1000,
    players: [],
    dealer: [],
    revealed: false,
    step: 0,
    nextHand: 0,
    cancelled: false,
  }
}

export function bet(round: Round, user: string, position: number, units: number) {
  if (
    round.phase !== 'betting' ||
    round.players.some((player) => player.user === user) ||
    units <= 0
  )
    throw new Fault('illegal_action', 409)
  round.players.push({ user, position, bet: units, hands: [] })
  round.players.sort((a, b) => a.position - b.position)
}

export function clearBet(round: Round, user: string): number {
  const player = round.players.find((entry) => entry.user === user)
  if (round.phase !== 'betting' || !player) throw new Fault('illegal_action', 409)
  round.players = round.players.filter((entry) => entry.user !== user)
  return player.bet
}

function makeHand(
  round: Round,
  stake: number,
  original: number,
  cards: Card[] = [],
  split = false,
  splitAces = false,
): Hand {
  return {
    id: round.nextHand++,
    cards,
    stake,
    original,
    split,
    splitAces,
    doubled: false,
    status: 'open',
  }
}

function windowUntil(round: Round, now: number) {
  return now + round.seconds * 1000
}

function canSplit(player: Participant, hand: Hand, rules: Rules) {
  if (rules.split === 'off' || hand.cards.length !== 2 || player.hands.length >= rules.maxHands)
    return false
  if (hand.split && !rules.resplit) return false
  const [a, b] = hand.cards
  if (hand.split && a.rank === 'A' && b.rank === 'A' && !rules.resplitAces) return false
  return rules.split === 'rank' ? a.rank === b.rank : cardValue(a) === cardValue(b)
}

function canDouble(hand: Hand, rules: Rules) {
  if (hand.cards.length !== 2 || rules.double === 'off' || (hand.split && !rules.doubleAfterSplit))
    return false
  if (rules.double === 'any') return true
  const value = handValue(hand.cards)
  return !value.soft && value.total >= (rules.double === '9-11' ? 9 : 10) && value.total <= 11
}

export function legalActions(round: Round, user: string): Action[] {
  const player = round.players.find((entry) => entry.user === user)
  if (!player) return []
  const first = player.hands[0]
  if (round.phase === 'early') {
    return !player.earlyAnswered && first.status !== 'natural' ? ['surrender', 'decline'] : []
  }
  if (round.phase === 'insurance') {
    return player.insurance === undefined && first.status !== 'surrender'
      ? ['insure', 'decline']
      : []
  }
  if (round.phase !== 'playing' || round.turn?.user !== user) return []
  const hand = player.hands.find((entry) => entry.id === round.turn?.hand)
  if (!hand || hand.status !== 'open') return []
  const lockedAces = hand.splitAces && !round.rules.hitSplitAces
  const actions: Action[] = ['stand']
  if (!lockedAces) {
    actions.unshift('hit')
    if (canDouble(hand, round.rules)) actions.push('double')
  }
  if (canSplit(player, hand, round.rules)) actions.push('split')
  if (round.rules.surrender === 'late' && !hand.split && hand.cards.length === 2)
    actions.push('surrender')
  return actions
}

export function actionCost(round: Round, user: string, action: Action): number {
  if (!legalActions(round, user).includes(action)) throw new Fault('illegal_action', 409)
  const player = round.players.find((entry) => entry.user === user)!
  if (action === 'insure') return player.bet / 2
  if (action === 'split' || action === 'double')
    return player.hands.find((entry) => entry.id === round.turn?.hand)!.stake
  return 0
}

function afterEarly(round: Round, shoe: Shoe, now: number, emit: Emit) {
  if (
    round.rules.insurance &&
    round.dealer[0]?.rank === 'A' &&
    round.players.some((player) => player.hands[0].status !== 'surrender')
  ) {
    round.phase = 'insurance'
    round.deadline = windowUntil(round, now)
    emit('insurance')
    return
  }
  afterInsurance(round, shoe, now, emit)
}

function afterInsurance(round: Round, shoe: Shoe, now: number, emit: Emit) {
  if (round.rules.holeCard === 'american' && natural(round.dealer)) {
    finishDealer(round, shoe, emit)
    return
  }
  nextTurn(round, shoe, now, emit)
}

export function deal(round: Round, shoe: Shoe, now: number, emit: Emit) {
  if (round.phase !== 'betting' || !round.players.length) throw new Fault('illegal_action', 409)
  try {
    for (const player of round.players)
      player.hands.push(makeHand(round, player.bet, player.bet, [draw(shoe)]))
    round.dealer.push(draw(shoe))
    for (const player of round.players) {
      const hand = player.hands[0]
      hand.cards.push(draw(shoe))
      if (natural(hand.cards)) hand.status = 'natural'
    }
    if (round.rules.holeCard === 'american') round.dealer.push(draw(shoe))
    emit('deal')
    if (
      round.rules.surrender === 'early' &&
      round.players.some((player) => player.hands[0].status !== 'natural')
    ) {
      round.phase = 'early'
      round.deadline = windowUntil(round, now)
      emit('early')
      return
    }
    afterEarly(round, shoe, now, emit)
  } catch (error) {
    if (!(error instanceof EmptyShoe)) throw error
    cancelRound(round, emit)
  }
}

function nextTurn(round: Round, shoe: Shoe, now: number, emit: Emit) {
  for (const player of round.players) {
    const hand = player.hands.find((entry) => entry.status === 'open')
    if (hand) {
      round.phase = 'playing'
      round.step++
      round.turn = { user: player.user, hand: hand.id, step: round.step }
      round.deadline = windowUntil(round, now)
      emit('turn', player.position)
      return
    }
  }
  finishDealer(round, shoe, emit)
}

function applyDraw(hand: Hand, shoe: Shoe) {
  hand.cards.push(draw(shoe))
  const total = handValue(hand.cards).total
  if (total > 21) hand.status = 'bust'
  else if (total === 21) hand.status = 'stand'
}

function finishDealer(round: Round, shoe: Shoe, emit: Emit) {
  round.turn = undefined
  round.deadline = undefined
  round.phase = 'settling'
  if (round.rules.holeCard === 'european') round.dealer.push(draw(shoe))
  round.revealed = true
  emit('reveal')
  const hasComparableHand = round.players.some((player) =>
    player.hands.some((hand) => hand.status === 'stand'),
  )
  if (hasComparableHand && !natural(round.dealer)) {
    let value = handValue(round.dealer)
    while (value.total < 17 || (value.total === 17 && value.soft && round.rules.soft17 === 'hit')) {
      round.dealer.push(draw(shoe))
      emit('dealerHit')
      value = handValue(round.dealer)
    }
  }
  score(round)
}

export function act(
  round: Round,
  shoe: Shoe,
  user: string,
  action: Action,
  now: number,
  emit: Emit,
) {
  actionCost(round, user, action)
  const player = round.players.find((entry) => entry.user === user)!
  try {
    if (round.phase === 'early') {
      player.earlyAnswered = true
      if (action === 'surrender') {
        player.hands[0].status = 'surrender'
        player.hands[0].early = true
      }
      emit(action, player.position)
      if (round.players.every((entry) => !legalActions(round, entry.user).length))
        afterEarly(round, shoe, now, emit)
      return
    }
    if (round.phase === 'insurance') {
      player.insurance = action === 'insure' ? player.bet / 2 : 0
      emit(action, player.position)
      if (round.players.every((entry) => !legalActions(round, entry.user).length))
        afterInsurance(round, shoe, now, emit)
      return
    }
    const index = player.hands.findIndex((entry) => entry.id === round.turn!.hand)
    const hand = player.hands[index]
    if (action === 'hit') applyDraw(hand, shoe)
    if (action === 'stand') hand.status = 'stand'
    if (action === 'surrender') hand.status = 'surrender'
    if (action === 'double') {
      hand.doubled = true
      hand.stake *= 2
      applyDraw(hand, shoe)
      if (hand.status === 'open') hand.status = 'stand'
    }
    if (action === 'split') {
      const [left, right] = hand.cards
      const lockedAces = left.rank === 'A' && !round.rules.hitSplitAces
      const first = makeHand(round, hand.stake, hand.original, [left], true, left.rank === 'A')
      const second = makeHand(round, hand.stake, 0, [right], true, right.rank === 'A')
      // Publish the two hands before drawing. A refund then retains both funded stakes even if the shoe runs out.
      player.hands.splice(index, 1, first, second)
      for (const splitHand of [first, second]) {
        applyDraw(splitHand, shoe)
        if (lockedAces && splitHand.status === 'open' && !canSplit(player, splitHand, round.rules))
          splitHand.status = 'stand'
      }
    }
    emit(action, player.position)
    nextTurn(round, shoe, now, emit)
  } catch (error) {
    if (!(error instanceof EmptyShoe)) throw error
    cancelRound(round, emit)
  }
}

export function timeout(round: Round, shoe: Shoe, at: number, emit: Emit) {
  if (round.phase === 'early' || round.phase === 'insurance') {
    const phase = round.phase
    for (const player of round.players) {
      if (round.phase === phase && legalActions(round, player.user).includes('decline'))
        act(round, shoe, player.user, 'decline', at, emit)
    }
  } else if (round.phase === 'playing' && round.turn) {
    act(round, shoe, round.turn.user, 'stand', at, emit)
  }
}

export function cancelRound(round: Round, emit: Emit) {
  round.phase = 'settling'
  round.cancelled = true
  round.turn = undefined
  round.deadline = undefined
  round.revealed = true
  for (const player of round.players) {
    if (!player.hands.length) player.hands.push(makeHand(round, player.bet, player.bet))
    for (const hand of player.hands) {
      hand.result = 'refund'
      hand.returned = hand.stake
    }
    player.insuranceReturned = player.insurance ?? 0
  }
  emit('refund')
}

export function score(round: Round) {
  const dealerNatural = natural(round.dealer)
  const dealerTotal = handValue(round.dealer).total
  for (const player of round.players) {
    player.insuranceReturned = dealerNatural ? (player.insurance ?? 0) * 3 : 0
    for (const hand of player.hands) {
      const total = handValue(hand.cards).total
      if (hand.status === 'surrender' && (hand.early || !dealerNatural)) {
        hand.result = 'surrender'
        hand.returned = hand.stake / 2
      } else if (dealerNatural) {
        if (hand.status === 'natural') {
          hand.result = 'push'
          hand.returned = hand.stake
        } else {
          hand.result = 'loss'
          hand.returned =
            round.rules.holeCard === 'european' && round.rules.dealerBlackjack === 'original'
              ? hand.stake - hand.original
              : 0
        }
      } else if (hand.status === 'bust') {
        hand.result = 'bust'
        hand.returned = 0
      } else if (hand.status === 'natural') {
        hand.result = 'blackjack'
        hand.returned = round.rules.payout === '3:2' ? (hand.stake * 5) / 2 : (hand.stake * 11) / 5
      } else if (dealerTotal > 21 || total > dealerTotal) {
        hand.result = 'win'
        hand.returned = hand.stake * 2
      } else if (total === dealerTotal) {
        hand.result = 'push'
        hand.returned = hand.stake
      } else {
        hand.result = 'loss'
        hand.returned = 0
      }
    }
  }
}
