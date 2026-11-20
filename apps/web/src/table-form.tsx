import { useState } from 'react'
import type { FormEvent } from 'react'
import { DECKS, DEFAULT_TABLE, PRESETS, THEMES } from '../../../packages/protocol/rules.ts'
import type { Rules, TableSettings } from '../../../packages/protocol/rules.ts'
import { useApp } from './state.tsx'

export function TableFields({
  value,
  setValue,
}: {
  value: TableSettings
  setValue: (value: TableSettings) => void
}) {
  const { t } = useApp()
  const [preset, setPreset] = useState('custom')
  function setting<K extends keyof TableSettings>(key: K, next: TableSettings[K], reset = false) {
    if (reset) setPreset('custom')
    setValue({ ...value, [key]: next })
  }
  function rule<K extends keyof Rules>(key: K, next: Rules[K]) {
    setPreset('custom')
    setting('rules', { ...value.rules, [key]: next })
  }
  function choose(next: string) {
    setPreset(next)
    if (next !== 'custom') setValue({ ...value, ...PRESETS[next as keyof typeof PRESETS] })
  }
  const checkbox = (
    key: 'private' | 'spectators' | 'chat' | 'friendInvites' | 'autoNext' | 'lateEntry',
    label: string,
  ) => (
    <label key={key} className="check-field">
      <input
        type="checkbox"
        checked={value[key]}
        onChange={(e) => setting(key, e.target.checked)}
      />
      {t(label)}
    </label>
  )
  const ruleCheck = (
    key: 'doubleAfterSplit' | 'resplit' | 'resplitAces' | 'hitSplitAces' | 'insurance',
    enabled = true,
  ) => (
    <label key={key} className="check-field">
      <input
        type="checkbox"
        checked={value.rules[key]}
        disabled={!enabled}
        onChange={(e) => rule(key, e.target.checked)}
      />
      {t(key)}
    </label>
  )
  const numberField = (
    key: 'minBet' | 'maxBet' | 'bettingSeconds' | 'turnSeconds' | 'maxPlayers',
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="field" key={key}>
      {t(label)}
      <input
        type="number"
        required
        min={min}
        max={max}
        value={value[key] || ''}
        onChange={(e) =>
          setting(key, Number(e.target.value), key === 'bettingSeconds' || key === 'turnSeconds')
        }
      />
    </label>
  )
  function options<K extends keyof Rules>(
    key: K,
    label: string,
    choices: Rules[K][],
    labels?: string[],
  ) {
    return (
      <label className="field">
        {t(label)}
        <select
          value={String(value.rules[key])}
          onChange={(e) =>
            rule(
              key,
              choices.find((choice) => String(choice) === e.target.value)!,
            )
          }
        >
          {choices.map((choice, index) => (
            <option value={String(choice)} key={String(choice)}>
              {labels
                ? t(labels[index])
                : typeof choice === 'number' || String(choice).includes(':')
                  ? choice
                  : t(String(choice))}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <>
      <label className="field">
        {t('tableName')}
        <input
          value={value.name}
          onChange={(e) => setting('name', e.target.value)}
          minLength={2}
          maxLength={44}
          required
        />
      </label>
      <label className="field">
        {t('tableDesc')}
        <input
          value={value.description}
          onChange={(e) => setting('description', e.target.value)}
          maxLength={180}
        />
      </label>
      {numberField('maxPlayers', 'maxPlayers', 1, 7)}
      {numberField('minBet', 'minBet', 1, 100000)}
      {numberField('maxBet', 'maxBet', value.minBet || 1, 100000)}
      <label className="field">
        {t('theme')}
        <select
          value={value.theme}
          onChange={(e) => setting('theme', e.target.value as TableSettings['theme'])}
        >
          {THEMES.map((name) => (
            <option value={name} key={name}>
              {t(name === 'minimal' ? 'loungeMinimal' : name)}
            </option>
          ))}
        </select>
      </label>
      {numberField('bettingSeconds', 'betTime', 8, 90)}
      {numberField('turnSeconds', 'turnTime', 10, 90)}
      <label className="field">
        {t('speed')}
        <select
          value={value.speed}
          onChange={(e) => setting('speed', e.target.value as 'normal' | 'fast', true)}
        >
          <option value="normal">{t('normal')}</option>
          <option value="fast">{t('fast')}</option>
        </select>
      </label>
      <label className="field">
        {t('seats')}
        <select
          value={value.seats}
          onChange={(e) => setting('seats', e.target.value as 'choose' | 'first')}
        >
          <option value="choose">{t('choose')}</option>
          <option value="first">{t('first')}</option>
        </select>
      </label>
      {(
        [
          ['private', 'private'],
          ['spectators', 'spectators'],
          ['chat', 'chatOn'],
          ['friendInvites', 'friendInvites'],
          ['autoNext', 'autoNext'],
          ['lateEntry', 'lateEntry'],
        ] as const
      ).map(([key, label]) => checkbox(key, label))}
      <hr className="form-wide" />
      <label className="field form-wide">
        {t('preset')}
        <select value={preset} onChange={(e) => choose(e.target.value)}>
          {[
            ['custom', 'custom'],
            ['classic', 'classic'],
            ['vegas', 'vegas'],
            ['european', 'europeanPreset'],
            ['fast', 'fastFriends'],
          ].map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
      {options('decks', 'decks', [...DECKS])}
      {options('payout', 'payout', ['3:2', '6:5'])}
      {options('soft17', 'soft17', ['stand', 'hit'])}
      {options(
        'double',
        'double',
        ['any', '9-11', '10-11', 'off'],
        ['any', 'hard9', 'hard10', 'off'],
      )}
      {options('split', 'splitRule', ['rank', 'value', 'off'])}
      {options('maxHands', 'maxHands', [2, 3, 4])}
      {options('surrender', 'surrender', ['none', 'early', 'late'], ['none', 'earlyRule', 'late'])}
      {options('holeCard', 'holeCard', ['american', 'european'])}
      {value.rules.holeCard === 'european' &&
        options('dealerBlackjack', 'dealerBlackjack', ['all', 'original'], ['allBets', 'original'])}
      <label className="field">
        {t('penetration')}
        <input
          type="number"
          min="35"
          max="85"
          value={value.rules.penetration || ''}
          onChange={(e) => rule('penetration', Number(e.target.value))}
          required
        />
      </label>
      {ruleCheck('doubleAfterSplit', value.rules.double !== 'off' && value.rules.split !== 'off')}
      {ruleCheck('resplit', value.rules.split !== 'off')}
      {ruleCheck('resplitAces', value.rules.split !== 'off' && value.rules.resplit)}
      {ruleCheck('hitSplitAces', value.rules.split !== 'off')}
      {ruleCheck('insurance')}
    </>
  )
}

export function TableForm({
  initial = DEFAULT_TABLE,
  label,
  submit,
  busy,
}: {
  initial?: TableSettings
  label: string
  submit: (settings: TableSettings) => void
  busy: boolean
}) {
  const [value, setValue] = useState<TableSettings>(() => structuredClone(initial))
  function handle(event: FormEvent) {
    event.preventDefault()
    submit(value)
  }
  return (
    <form className="panel form-panel form-grid" onSubmit={handle}>
      <TableFields value={value} setValue={setValue} />
      <div className="form-wide">
        <button className="button button-primary" disabled={busy}>
          {label}
        </button>
      </div>
    </form>
  )
}
