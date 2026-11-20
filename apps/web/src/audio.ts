import type { EventKind, Preferences } from '../../../packages/protocol/types.ts'

let audio: AudioContext | undefined

export async function unlock() {
  try {
    audio ??= new AudioContext()
    await audio.resume()
  } catch {
    /* Audio is optional. */
  }
}

function tone(
  frequency: number,
  delay: number,
  duration: number,
  strength: number,
  type: OscillatorType = 'sine',
) {
  if (!audio || audio.state !== 'running' || document.hidden || strength <= 0) return
  const at = audio.currentTime + delay
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = type
  osc.frequency.value = frequency
  gain.gain.setValueAtTime(0.00001, at)
  gain.gain.exponentialRampToValueAtTime(strength, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.00001, at + duration)
  osc.connect(gain).connect(audio.destination)
  osc.start(at)
  osc.stop(at + duration + 0.015)
}

export function cue(
  event: EventKind | 'premium' | 'warning' | 'loss' | 'push' | 'click',
  preferences: Preferences,
) {
  if (!preferences.audio) return
  const volume = preferences.volume * preferences.effects * 0.1
  if (event === 'premium' || event === 'settled') {
    const pitches = event === 'premium' ? [440, 554, 659, 880] : [392, 494, 587]
    pitches.forEach((pitch, index) => tone(pitch, index * 0.09, 0.28, volume, 'triangle'))
  } else if (event === 'loss' || event === 'push')
    tone(event === 'loss' ? 190 : 310, 0, 0.16, volume * 0.66, 'sine')
  else if (event === 'bet' || event === 'split' || event === 'double' || event === 'refund') {
    tone(616, 0, 0.055, volume, 'triangle')
    tone(812, 0.042, 0.07, volume * 0.65, 'triangle')
  } else if (
    event === 'deal' ||
    event === 'hit' ||
    event === 'dealerHit' ||
    event === 'shuffle' ||
    event === 'reveal'
  ) {
    const times = event === 'shuffle' || event === 'deal' ? 4 : 1
    for (let i = 0; i < times; i++) tone(156 + i * 30, i * 0.055, 0.09, volume * 0.65, 'triangle')
  } else if (
    event === 'turn' ||
    event === 'warning' ||
    event === 'betting' ||
    event === 'chat' ||
    event === 'click'
  ) {
    tone(event === 'warning' ? 510 : 340, 0, 0.14, volume * 0.7)
    tone(event === 'warning' ? 620 : 450, 0.12, 0.14, volume * 0.7)
  }
}

export function music(preferences: Preferences) {
  if (!preferences.audio || preferences.music <= 0) return
  const gain = preferences.volume * preferences.music * 0.045
  const chords = [
    [110, 165, 220, 261.6],
    [146.8, 220, 261.6, 349.2],
    [98, 146.8, 196, 246.9],
  ]
  chords[Math.floor(Date.now() / 5000) % chords.length].forEach((pitch, index) =>
    tone(pitch, index * 0.18, 4.1, gain, 'sine'),
  )
}
