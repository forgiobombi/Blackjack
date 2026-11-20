import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  cardValue,
  draw,
  handValue,
  natural,
  newShoe,
  secureInt,
} from '../packages/engine/cards.ts'
import type { Shoe } from '../packages/engine/cards.ts'
import {
  act,
  actionCost,
  bet,
  cancelRound,
  clearBet,
  deal,
  legalActions,
  openRound,
  timeout,
} from '../packages/engine/round.ts'
import {
  CLASSIC,
  DEFAULT_TABLE,
  IDLE_MS,
  LAST_WARNING_MS,
  MIN_WARNING_MS,
} from '../packages/protocol/rules.ts'
import type { Rules } from '../packages/protocol/rules.ts'
import type { Card, EventKind } from '../packages/protocol/types.ts'
import { parseCommand, parseSettings } from '../packages/protocol/validation.ts'
import { dueAt, frame, idleAt, touch } from '../apps/worker/src/table-model.ts'
import type { TableState } from '../apps/worker/src/table-model.ts'

const user = 'player1'
const when = 100_000
const noEvent = () => {}
function shoe(...ranks: Card['rank'][]): Shoe {
  return { cards: ranks.map((rank, id) => ({ rank, id, suit: 'S' })), cursor: 0 }
}
function create(rules: Partial<Rules> = {}) {
  return openRound(crypto.randomUUID(), when, { ...CLASSIC, ...rules }, 20, 25)
}
function start(
  cards: Shoe,
  rules: Partial<Rules> = {},
  emit = noEvent as (event: EventKind) => void,
) {
  const round = create(rules)
  bet(round, user, 0, 50)
  deal(round, cards, when, emit)
  return round
}

test('Face cards, hard totals, soft totals and multiple aces', () => {
  assert.equal(cardValue(shoe('J').cards[0]), 10)
  assert.equal(cardValue(shoe('7').cards[0]), 7)
  assert.deepEqual(handValue(shoe('A', 'A', '5').cards), { total: 17, soft: true })
  assert.deepEqual(handValue(shoe('A', 'A', '5', 'Q').cards), { total: 17, soft: false })
  assert.deepEqual(handValue(shoe('Q', 'K', '8').cards), { total: 28, soft: false })
  assert.equal(natural(shoe('Q', '6', '5').cards), false)
})
test('Unbiased production random integer preserves bounds and all decks have unique cards', () => {
  for (const decks of [1, 2, 4, 6, 8]) {
    const deck = newShoe(decks)
    assert.equal(new Set(deck.cards.map((card) => card.id)).size, 52 * decks)
    assert.equal(new Set(deck.cards.map((card) => card.rank + card.suit)).size, 52)
    for (let i = 0; i < 52 * decks; i++) draw(deck)
    assert.throws(() => draw(deck))
  }
  for (let i = 0; i < 500; i++) assert.ok(secureInt(31) < 31)
  assert.deepEqual(
    newShoe(1, () => 0),
    newShoe(1, () => 0),
  )
})
test('Natural blackjack returns stake plus exact 3:2 or 6:5 profit', () => {
  assert.equal(start(shoe('A', '9', 'J', '8')).players[0].hands[0].returned, 125)
  assert.equal(start(shoe('A', '9', 'J', '8'), { payout: '6:5' }).players[0].hands[0].returned, 110)
})
test('Two naturals push after declining insurance', () => {
  const deck = shoe('A', 'A', 'J', 'Q')
  const round = start(deck)
  assert.equal(round.phase, 'insurance')
  assert.equal(round.revealed, false)
  act(round, deck, user, 'decline', when, noEvent)
  assert.equal(round.players[0].hands[0].result, 'push')
  assert.equal(round.players[0].hands[0].returned, 50)
})
test('American 10-value upcard peeks, ending play against a dealer natural', () => {
  const round = start(shoe('9', 'K', '7', 'A'))
  assert.equal(round.phase, 'settling')
  assert.equal(round.players[0].hands[0].result, 'loss')
  assert.equal(round.turn, undefined)
})
test('Dealer soft 17 differs between S17 and H17', () => {
  for (const [soft17, returned] of [
    ['stand', 100],
    ['hit', 50],
  ] as const) {
    const deck = shoe('8', 'A', '10', '6', 'A')
    const round = start(deck, { soft17, insurance: false })
    act(round, deck, user, 'stand', when, noEvent)
    assert.equal(round.players[0].hands[0].returned, returned)
  }
})
test('Stand resolves a standard win, loss or push', () => {
  for (const [up, down, result] of [
    ['7', '10', 'win'],
    ['K', '10', 'loss'],
    ['8', '10', 'push'],
  ] as const) {
    const deck = shoe('10', up, '8', down)
    const round = start(deck)
    act(round, deck, user, 'stand', when, noEvent)
    assert.equal(round.players[0].hands[0].result, result)
  }
})
test('Hit accepts another card and bust loses on its own', () => {
  const deck = shoe('Q', '8', '6', '9', '9')
  const round = start(deck)
  act(round, deck, user, 'hit', when, noEvent)
  assert.equal(round.players[0].hands[0].result, 'bust')
  assert.equal(round.players[0].hands[0].returned, 0)
})
test('Dealer bust pays even money and cannot rescue a busted player', () => {
  const deck = shoe('Q', '6', '9', '10', 'Q')
  const round = start(deck)
  act(round, deck, user, 'stand', when, noEvent)
  assert.ok(handValue(round.dealer).total > 21)
  assert.equal(round.players[0].hands[0].returned, 100)
})
test('Double takes exactly one card, doubles the stake and observes hard total restrictions', () => {
  const deck = shoe('5', '8', '6', '8', '10', '2')
  const round = start(deck, { double: '10-11' })
  assert.equal(actionCost(round, user, 'double'), 50)
  act(round, deck, user, 'double', when, noEvent)
  assert.equal(round.players[0].hands[0].stake, 100)
  assert.equal(round.players[0].hands[0].cards.length, 3)
  assert.equal(round.players[0].hands[0].returned, 200)
  assert.ok(
    !legalActions(start(shoe('A', '8', '9', '7'), { double: '9-11' }), user).includes('double'),
  )
})
test('Split pays separate hands; a split 21 is not a blackjack', () => {
  const deck = shoe('J', '8', 'Q', '9', 'A', '3', '9')
  const round = start(deck, { split: 'value', doubleAfterSplit: false })
  assert.equal(actionCost(round, user, 'split'), 50)
  act(round, deck, user, 'split', when, noEvent)
  assert.equal(round.players[0].hands.length, 2)
  assert.ok(!legalActions(round, user).includes('double'))
  act(round, deck, user, 'hit', when, noEvent)
  assert.deepEqual(
    round.players[0].hands.map((hand) => hand.result),
    ['win', 'bust'],
  )
})
test('Rank-only split disallows different face-card ranks', () => {
  const round = start(shoe('J', '8', 'K', '9'), { split: 'rank' })
  assert.ok(!legalActions(round, user).includes('split'))
})
test('Split aces stand after one card, and permitted ace resplits work', () => {
  for (const allowed of [false, true]) {
    const deck = shoe('A', '6', 'A', '10', 'A', '10', '9', '6', '8')
    const round = start(deck, { resplitAces: allowed })
    act(round, deck, user, 'split', when, noEvent)
    if (allowed) {
      assert.deepEqual(legalActions(round, user), ['stand', 'split'])
      act(round, deck, user, 'split', when, noEvent)
      assert.equal(round.players[0].hands.length, 3)
    } else {
      assert.equal(round.players[0].hands.length, 2)
      assert.equal(round.players[0].hands[1].cards.length, 2)
      assert.equal(round.phase, 'settling')
    }
    assert.ok(round.players[0].hands.every((hand) => hand.status !== 'natural'))
  }
})
test('Insurance returns stake and 2:1 profit on a dealer natural only', () => {
  for (const hole of ['J', '7'] as const) {
    const deck = shoe('K', 'A', '9', hole)
    const round = start(deck)
    assert.equal(actionCost(round, user, 'insure'), 25)
    act(round, deck, user, 'insure', when, noEvent)
    if (round.phase === 'playing') act(round, deck, user, 'stand', when, noEvent)
    assert.equal(round.players[0].insuranceReturned, hole === 'J' ? 75 : 0)
  }
})
test('Early surrender preserves half versus natural, whereas late surrender follows peek', () => {
  const deck = shoe('9', 'K', '7', 'A')
  const round = start(deck, { surrender: 'early' })
  assert.equal(round.phase, 'early')
  act(round, deck, user, 'surrender', when, noEvent)
  assert.equal(round.players[0].hands[0].returned, 25)
  assert.ok(!legalActions(start(shoe('9', 'K', '7', 'A'), { surrender: 'late' }), user).length)
  const regular = shoe('9', 'K', '7', '9')
  const late = start(regular, { surrender: 'late' })
  act(late, regular, user, 'surrender', when, noEvent)
  assert.equal(late.players[0].hands[0].returned, 25)
})
test('European dealer pulls second card after actions and original-only returns the double', () => {
  for (const mode of ['all', 'original'] as const) {
    const deck = shoe('5', 'A', '6', '10', 'K')
    const round = start(deck, { holeCard: 'european', insurance: false, dealerBlackjack: mode })
    assert.equal(round.dealer.length, 1)
    act(round, deck, user, 'double', when, noEvent)
    assert.equal(round.dealer.length, 2)
    assert.equal(round.players[0].hands[0].returned, mode === 'all' ? 0 : 50)
  }
})
test('European original-only settles across split hands without duplicating the initial stake', () => {
  const deck = shoe('8', 'K', '8', '10', 'A', 'A')
  const round = start(deck, { holeCard: 'european', dealerBlackjack: 'original' })
  act(round, deck, user, 'split', when, noEvent)
  act(round, deck, user, 'stand', when, noEvent)
  act(round, deck, user, 'stand', when, noEvent)
  assert.deepEqual(
    round.players[0].hands.map((hand) => hand.returned),
    [0, 50],
  )
})
test('Shoe exhaustion refunds all stakes after a partially funded split', () => {
  const deck = shoe('9', '9', '9', '8', '7')
  const round = start(deck)
  act(round, deck, user, 'split', when, noEvent)
  assert.equal(round.cancelled, true)
  assert.deepEqual(
    round.players[0].hands.map((hand) => hand.returned),
    [50, 50],
  )
})
test('Cancelling with undealt cards returns confirmed bets', () => {
  const round = create()
  bet(round, user, 0, 100)
  cancelRound(round, noEvent)
  assert.equal(round.players[0].hands[0].returned, 100)
  assert.equal(round.players[0].hands[0].result, 'refund')
})
test('Reject duplicate bets, clearing a missing bet, illegal actions and wrong turn owner', () => {
  const round = create()
  bet(round, user, 0, 50)
  assert.throws(() => bet(round, user, 0, 50), /illegal_action/)
  assert.equal(clearBet(round, user), 50)
  assert.throws(() => clearBet(round, user), /illegal_action/)
  const deck = shoe('9', '9', '6', '8')
  const live = start(deck)
  assert.throws(() => act(live, deck, 'spectator', 'hit', when, noEvent), /illegal_action/)
  assert.throws(() => act(live, deck, user, 'insure', when, noEvent), /illegal_action/)
})
test('Decision timeout declines insurance and then stands the live hand at the next deadline', () => {
  const deck = shoe('K', 'A', '4', '8')
  const round = start(deck)
  const deadline = round.deadline!
  timeout(round, deck, deadline, noEvent)
  assert.equal(round.players[0].insurance, 0)
  assert.equal(round.deadline, deadline + 25_000)
  timeout(round, deck, round.deadline!, noEvent)
  assert.equal(round.phase, 'settling')
  assert.equal(round.players[0].hands[0].result, 'loss')
})
test('Turn order and card identities remain correct with seven simultaneous seats', () => {
  const deck = newShoe(8, () => 0)
  const round = create({ insurance: false })
  for (let i = 6; i >= 0; i--) bet(round, 'player' + i, i, 50)
  deal(round, deck, when, noEvent)
  while (round.turn) act(round, deck, round.turn.user, 'stand', when, noEvent)
  assert.deepEqual(
    round.players.map((player) => player.position),
    [0, 1, 2, 3, 4, 5, 6],
  )
  const visible = [
    ...round.dealer,
    ...round.players.flatMap((p) => p.hands.flatMap((h) => h.cards)),
  ]
  assert.equal(new Set(visible.map((c) => c.id)).size, visible.length)
  assert.equal(visible.length, deck.cursor)
})
function tableFixture(): TableState {
  return {
    id: 'test',
    owner: user,
    createdAt: when,
    settings: { ...DEFAULT_TABLE, name: 'Test' },
    lastActive: when,
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
}
test('Public snapshots cannot reveal a hidden dealer card or the rest of the shoe', () => {
  const deck = shoe('5', '9', '6', '8', '4', '5')
  const state = tableFixture()
  state.round = start(deck)
  state.shoe = deck
  const publicFrame = frame(state, 'deal', when)
  assert.deepEqual(publicFrame.dealer, [deck.cards[1], null])
  assert.equal(publicFrame.dealerTotal, 9)
  assert.equal('shoe' in publicFrame, false)
})
test('Inactivity warnings and closure deadlines are absolute and reset only on touch', () => {
  const state = tableFixture()
  assert.equal(dueAt(state), when + MIN_WARNING_MS)
  state.warning = 1
  assert.equal(dueAt(state), when + LAST_WARNING_MS)
  state.warning = 2
  assert.equal(dueAt(state), when + IDLE_MS)
  assert.equal(idleAt(state), when + IDLE_MS)
  touch(state, when + 10_000)
  assert.equal(dueAt(state), when + 10_000 + MIN_WARNING_MS)
})
test('Protocol rejects float chip wagers, invalid IDs and malformed settings', () => {
  const id = crypto.randomUUID()
  assert.throws(() => parseCommand({ kind: 'bet', id, tableId: id, roundId: id, chips: 3.5 }))
  assert.throws(() => parseCommand({ kind: 'stand', id: 'oops', tableId: id }))
  assert.throws(() => parseSettings({ ...DEFAULT_TABLE, name: 'Test', maxPlayers: 8 }))
  assert.throws(() => parseSettings({ ...DEFAULT_TABLE, name: 'Test', minBet: 900, maxBet: 800 }))
  assert.equal(parseSettings({ ...DEFAULT_TABLE, name: 'Test' }).maxPlayers, 7)
})
