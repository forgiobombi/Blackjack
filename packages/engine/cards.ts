import { RANKS, SUITS } from '../protocol/types.ts'
import type { Card } from '../protocol/types.ts'

export type Shoe = { cards: Card[]; cursor: number }
export type Uniform = (exclusiveMax: number) => number

export function secureInt(exclusiveMax: number): number {
  if (!Number.isInteger(exclusiveMax) || exclusiveMax < 1 || exclusiveMax > 0x100000000)
    throw new RangeError('Random integer bound')
  const limit = 0x100000000 - (0x100000000 % exclusiveMax)
  const buffer = new Uint32Array(1)
  do crypto.getRandomValues(buffer)
  while (buffer[0] >= limit)
  return buffer[0] % exclusiveMax
}

export function newShoe(decks: number, uniform: Uniform = secureInt): Shoe {
  const cards: Card[] = []
  for (let deck = 0; deck < decks; deck++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ id: cards.length, rank, suit })
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = uniform(i + 1)
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return { cards, cursor: 0 }
}

export function cardValue(card: Card): number {
  return card.rank === 'A' ? 1 : Math.min(RANKS.indexOf(card.rank) + 1, 10)
}

export function handValue(cards: readonly Card[]) {
  let total = 0
  let aces = 0
  for (const card of cards) {
    total += cardValue(card)
    if (card.rank === 'A') aces++
  }
  const soft = aces > 0 && total + 10 <= 21
  return { total: total + (soft ? 10 : 0), soft }
}

export function natural(cards: readonly Card[]) {
  return cards.length === 2 && handValue(cards).total === 21
}

export class EmptyShoe extends Error {}

export function draw(shoe: Shoe): Card {
  if (shoe.cursor >= shoe.cards.length) throw new EmptyShoe()
  return shoe.cards[shoe.cursor++]
}
