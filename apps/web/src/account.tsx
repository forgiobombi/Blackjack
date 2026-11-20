import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { THEMES } from '../../../packages/protocol/rules.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import { AVATARS } from '../../../packages/protocol/types.ts'
import type {
  Avatar,
  Frame,
  Preferences,
  Profile,
  RoundSummary,
  Stats,
  TableSummary,
} from '../../../packages/protocol/types.ts'
import { api, codeOf } from './api.ts'
import { Board } from './board.tsx'
import { chipCount, dateTime } from './i18n.ts'
import { useApp, useResource } from './state.tsx'
import { AvatarIcon, Empty, Icon, Modal, Notice, PageTitle } from './ui.tsx'

const accountTabs = [
  'profile',
  'preferences',
  'friends',
  'stats',
  'history',
  'leaders',
  'achievements',
]
const statNames = ['rounds', 'wins', 'losses', 'pushes', 'blackjacks', 'longest'] as const
const achievements: [string, keyof Stats, number][] = [
  ['firstGame', 'rounds', 1],
  ['firstWin', 'wins', 1],
  ['firstBlackjack', 'blackjacks', 1],
  ['fiveBlackjacks', 'blackjacks', 5],
  ['tenBlackjacks', 'blackjacks', 10],
  ['tenRounds', 'rounds', 10],
  ['fiftyRounds', 'rounds', 50],
  ['hundredRounds', 'rounds', 100],
  ['doubleWin', 'doubleWins', 1],
  ['splitWin', 'splitWins', 1],
  ['fiveStreak', 'longest', 5],
  ['socialWin', 'social', 1],
]

function StatsTiles({ data }: { data: Stats }) {
  const { t, locale } = useApp()
  return (
    <div className="stat-grid">
      {statNames.map((key) => (
        <div className="panel stat" key={key}>
          <span>{t(key)}</span>
          <b>{data[key].toLocaleString(locale)}</b>
        </div>
      ))}
      <div className="panel stat">
        <span>{t('percentage')}</span>
        <b>
          {Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
            data.rounds ? data.wins / data.rounds : 0,
          )}
        </b>
      </div>
    </div>
  )
}

type WalletActivity = {
  entries: { id: string; kind: string; delta: number; at: number }[]
  refill: { eligible: number; chips: number }
}
function MyProfile({ edit = false }: { edit?: boolean }) {
  const { t, me, setMe, locale, toast } = useApp()
  const stats = useResource<Stats>('/stats')
  const wallet = useResource<WalletActivity>('/me/wallet')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [avatar, setAvatar] = useState(me!.avatar)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    try {
      setMe(
        await api<Profile>('/me', {
          method: 'PATCH',
          body: {
            displayName: data.get('name'),
            avatar,
            privateStats: data.get('privateStats') === 'on',
          },
        }),
      )
      setError('')
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  async function refill() {
    setBusy(true)
    try {
      setMe(await api<Profile>('/me/refill', { body: { id: crypto.randomUUID() } }))
      wallet.reload()
      setError('')
      toast(t('refillReceived'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="stack">
      {error && <Notice error text={t(error)} />}
      <section className="panel form-panel">
        <div className="section-head">
          <div className="profile-head">
            <AvatarIcon avatar={me!.avatar} />
            <div>
              <h2>{me!.displayName}</h2>
              <p className="muted">
                @{me!.username} · {t('since')} {dateTime(me!.createdAt, locale)}
              </p>
            </div>
          </div>
          <div className="button-row">
            {stats.data && (
              <span className="badge">
                {t('level', { n: 1 + Math.floor(Math.sqrt(stats.data.rounds) / 2) })}
              </span>
            )}
            <a
              className="button button-outline"
              href={edit ? '#/account/profile' : '#/account/profile/edit'}
            >
              {t(edit ? 'back' : 'editProfile')}
            </a>
            <a className="button button-ghost" href="#/signout">
              {t('signOut')}
            </a>
          </div>
        </div>
        <div className="profile-wallet">
          <span className="wallet-chip">
            <Icon name="chip" />
            <b>{chipCount(me!.balance, locale)}</b> {t('chips')}
          </span>
          {wallet.data?.refill.eligible ? (
            <button className="button button-primary" onClick={() => void refill()} disabled={busy}>
              {t('refill')}
            </button>
          ) : (
            <small className="muted">{t('refillLater')}</small>
          )}
        </div>
        {edit && (
          <form className="form-grid" onSubmit={(event) => void save(event)}>
            <label className="field">
              {t('displayName')}
              <input
                name="name"
                defaultValue={me!.displayName}
                minLength={2}
                maxLength={32}
                required
              />
            </label>
            <fieldset className="avatar-picker">
              <legend>{t('avatar')}</legend>
              {AVATARS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="icon-button"
                  aria-label={t('avatar_' + item)}
                  aria-pressed={item === avatar}
                  onClick={() => setAvatar(item)}
                >
                  <AvatarIcon avatar={item} />
                </button>
              ))}
            </fieldset>
            <label className="check-field">
              <input type="checkbox" name="privateStats" defaultChecked={me!.privateStats} />
              {t('privateStats')}
            </label>
            <div className="form-wide">
              <button className="button button-primary" disabled={busy}>
                {t('save')}
              </button>
            </div>
          </form>
        )}
      </section>
      {stats.error && <Notice error text={t(stats.error)} />}
      {stats.data && <StatsTiles data={stats.data} />}
      <section className="panel data-panel">
        <h2>{t('ledger')}</h2>
        {wallet.error && <Notice error text={t(wallet.error)} />}
        {wallet.data?.entries.length === 0 && <Empty>{t('noLedger')}</Empty>}
        {wallet.data?.entries.map((entry) => (
          <div className="list-item" key={entry.id}>
            <div>
              <b>{t(entry.kind === 'refill' ? 'wallet_refill' : entry.kind)}</b>
              <small>{dateTime(entry.at, locale)}</small>
            </div>
            <span className={'net ' + (entry.delta < 0 ? 'net-loss' : 'net-win')}>
              {entry.delta >= 0 ? '+' : ''}
              {chipCount(entry.delta, locale)}
            </span>
          </div>
        ))}
      </section>
    </div>
  )
}

function PlayerPreferences() {
  const { t, me, setMe, locale, selectLocale, toast } = useApp()
  const [value, setValue] = useState(me!.preferences)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function update<K extends keyof Preferences>(key: K, next: Preferences[K]) {
    setValue((current) => ({ ...current, [key]: next }))
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      setMe(await api<Profile>('/me/preferences', { method: 'PATCH', body: { ...value, locale } }))
      setError('')
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  const choices = [
    ['motion', 'motion', ['high', 'balanced', 'minimal']],
    ['animationSpeed', 'animationSpeed', ['normal', 'fast']],
    ['cards', 'cardDesign', ['ivory', 'midnight']],
    ['chips', 'chipDesign', ['classic', 'plain']],
    ['density', 'density', ['cozy', 'compact']],
    ['theme', 'theme', ['table', ...THEMES]],
  ] as const
  return (
    <form className="panel form-panel form-grid" onSubmit={(e) => void save(e)}>
      {error && (
        <div className="form-wide">
          <Notice error text={t(error)} />
        </div>
      )}
      <label className="field">
        {t('language')}
        <select value={locale} onChange={(e) => selectLocale(e.target.value as 'en' | 'it')}>
          <option value="en">{t('english')}</option>
          <option value="it">{t('italian')}</option>
        </select>
      </label>
      {choices.map(([key, label, options]) => (
        <label className="field" key={key}>
          {t(label)}
          <select
            value={value[key]}
            onChange={(e) => update(key, e.target.value as Preferences[typeof key])}
          >
            {options.map((option) => (
              <option value={option} key={option}>
                {t(
                  key === 'theme' && option === 'minimal'
                    ? 'loungeMinimal'
                    : key === 'chips' && option === 'classic'
                      ? 'classicChip'
                      : option,
                )}
              </option>
            ))}
          </select>
        </label>
      ))}
      {(['volume', 'effects', 'music'] as const).map((key) => (
        <label className="field" key={key}>
          {t(key)} · {Math.round(value[key] * 100)}%
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={value[key]}
            onChange={(e) => update(key, Number(e.target.value))}
          />
        </label>
      ))}
      {(
        [
          ['audio', 'audio'],
          ['chat', 'showChat'],
          ['notifications', 'notifications'],
        ] as const
      ).map(([key, label]) => (
        <label className="check-field" key={key}>
          <input
            type="checkbox"
            checked={value[key]}
            onChange={(e) => update(key, e.target.checked)}
          />
          {t(label)}
        </label>
      ))}
      <div className="form-wide">
        <button className="button button-primary" disabled={busy}>
          {t('save')}
        </button>
      </div>
    </form>
  )
}

type Friend = {
  id: string
  name: string
  username: string
  avatar: Avatar
  status: 'friends' | 'requested'
  requestedBy: string
  lastPlayed?: number
  tableId?: string
}
type Social = {
  friends: Friend[]
  blocked: { id: string; name: string; username: string }[]
  invitations: { id: string; token: string; name: string; table: string; expiresAt: number }[]
}

function Friends() {
  const { t, me, toast, locale } = useApp()
  const resource = useResource<Social>('/friends')
  const [invite, setInvite] = useState<Friend>()
  const tables = useResource<{ tables: TableSummary[] }>(invite ? '/tables' : null)
  const [error, setError] = useState('')
  async function change(
    action: string,
    values: { user?: string; username?: FormDataEntryValue | null },
  ) {
    try {
      await api('/friends', { body: { action, ...values } })
      setError('')
      resource.reload()
      toast(t(action === 'request' ? 'friendSent' : 'updated'))
    } catch (e) {
      setError(codeOf(e))
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    await change('request', { username: new FormData(form).get('username') })
    form.reset()
  }
  async function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const table = new FormData(event.currentTarget).get('table')
    try {
      await api('/tables/' + table + '/invite', {
        body: { recipient: invite!.id, minutes: 120, uses: 1 },
      })
      setInvite(undefined)
      setError('')
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    }
  }
  const available = tables.data?.tables.filter(
    (table) =>
      table.status === 'open' &&
      (me!.role === 'superadmin' ||
        (me!.role === 'admin' && table.ownerId === me!.id) ||
        table.settings.friendInvites),
  )
  return (
    <div className="stack">
      {resource.error && <Notice error text={t(resource.error)} />}
      {error && !invite && <Notice error text={t(error)} />}
      <section className="panel form-panel">
        <form className="filters" onSubmit={(event) => void send(event)}>
          <label className="field">
            {t('requestFriend')}
            <input
              name="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_]+"
              placeholder={t('username')}
            />
          </label>
          <button className="button button-primary">
            <Icon name="plus" />
            {t('addFriend')}
          </button>
        </form>
      </section>
      <section className="panel data-panel">
        <h2>{t('friends')}</h2>
        {resource.data?.friends.length === 0 && <Empty>{t('noFriends')}</Empty>}
        {resource.data?.friends.map((person) => (
          <div className="list-item" key={person.id}>
            <div className="list-person">
              <AvatarIcon avatar={person.avatar} />
              <div>
                <b>{person.name}</b>
                <small>
                  @{person.username} ·{' '}
                  {t(
                    person.status === 'requested'
                      ? 'requested'
                      : person.tableId
                        ? 'online'
                        : 'presenceUnknown',
                  )}
                </small>
                {person.lastPlayed && (
                  <small>
                    {t('recentTogether', { date: dateTime(person.lastPlayed, locale) })}
                  </small>
                )}
              </div>
            </div>
            <div className="button-row">
              {person.status === 'requested' && person.requestedBy !== me!.id && (
                <button
                  className="button button-primary"
                  onClick={() => void change('accept', { user: person.id })}
                >
                  {t('accept')}
                </button>
              )}
              {person.status === 'friends' && (
                <button
                  className="button button-outline"
                  onClick={() => {
                    setInvite(person)
                    setError('')
                  }}
                >
                  {t('inviteFriend')}
                </button>
              )}
              <button
                className="button button-ghost"
                onClick={() =>
                  void change(person.status === 'requested' ? 'decline' : 'remove', {
                    user: person.id,
                  })
                }
              >
                {t(person.status === 'requested' ? 'decline' : 'remove')}
              </button>
              <button
                className="button button-ghost"
                onClick={() => void change('block', { user: person.id })}
              >
                {t('block')}
              </button>
            </div>
          </div>
        ))}
      </section>
      <section className="panel data-panel">
        <h2>{t('invites')}</h2>
        {resource.data?.invitations.length === 0 && <Empty>{t('noInvites')}</Empty>}
        {resource.data?.invitations.map((item) => (
          <div className="list-item" key={item.id}>
            <div>
              <b>{item.table}</b>
              <small>
                {t('from', { name: item.name })} ·{' '}
                {t('expires', { date: dateTime(item.expiresAt, locale) })}
              </small>
            </div>
            <a href={'#/join/' + item.token} className="button button-outline">
              {t('enterTable')}
            </a>
          </div>
        ))}
      </section>
      {Boolean(resource.data?.blocked.length) && (
        <section className="panel data-panel">
          <h2>{t('blocked')}</h2>
          {resource.data!.blocked.map((person) => (
            <div className="list-item" key={person.id}>
              <div>
                <b>{person.name}</b>
                <small>@{person.username}</small>
              </div>
              <button
                className="button button-outline"
                onClick={() => void change('unblock', { user: person.id })}
              >
                {t('unblock')}
              </button>
            </div>
          ))}
        </section>
      )}
      {invite && (
        <Modal
          title={t('inviteFriend') + ' · ' + invite.name}
          close={() => setInvite(undefined)}
          t={t}
        >
          {error && <Notice error text={t(error)} />}
          {tables.loading && <p role="status">{t('loading')}</p>}
          {available?.length === 0 && <Empty>{t('noTables')}</Empty>}
          {Boolean(available?.length) && (
            <form className="stack" onSubmit={(e) => void sendInvite(e)}>
              <label className="field">
                {t('tableName')}
                <select name="table" required>
                  {available!.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.settings.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button button-primary">{t('inviteMake')}</button>
            </form>
          )}
        </Modal>
      )}
    </div>
  )
}

function RoundHistory() {
  const { t, locale } = useApp()
  const resource = useResource<{ rounds: RoundSummary[] }>('/history')
  const [older, setOlder] = useState<RoundSummary[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const rounds = [...(resource.data?.rounds ?? []), ...older]
  async function more() {
    try {
      const { rounds: next } = await api<{ rounds: RoundSummary[] }>(
        '/history?before=' + rounds.at(-1)?.at,
      )
      setOlder((current) => [...current, ...next])
      setDone(next.length < 25)
      setError('')
    } catch (e) {
      setError(codeOf(e))
    }
  }
  if (resource.loading) return <p role="status">{t('loading')}</p>
  if (resource.error) return <Notice error text={t(resource.error)} />
  if (!rounds.length) return <Empty>{t('noHistory')}</Empty>
  return (
    <section className="panel data-panel">
      <div className="scroll-table">
        <table className="data-table">
          <thead>
            <tr>
              {['tableName', 'date', 'result', 'net', 'replay'].map((key) => (
                <th scope="col" key={key}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.id}>
                <td>{round.tableName}</td>
                <td>{dateTime(round.at, locale)}</td>
                <td>
                  <span className={'result result-' + round.outcome}>{t(round.outcome)}</span>
                </td>
                <td>
                  <span className={'net net-' + (round.delta < 0 ? 'loss' : 'win')}>
                    {round.delta > 0 ? '+' : ''}
                    {chipCount(round.delta, locale)}
                  </span>
                </td>
                <td>
                  <a href={'#/account/replay/' + round.id} className="button button-outline">
                    {t('replay')} <Icon name="arrow" size={14} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Notice error text={t(error)} />}
      {!done && rounds.length >= 25 && (
        <button className="button button-ghost" onClick={() => void more()}>
          {t('older')}
        </button>
      )}
    </section>
  )
}

function Replay({ id }: { id: string }) {
  const { t, me, locale } = useApp()
  const resource = useResource<{
    tableName: string
    at: number
    settings: TableSettings
    frames: Frame[]
  }>('/history/' + id)
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const length = resource.data?.frames.length ?? 0
  useEffect(() => {
    if (!playing) return
    if (cursor >= length - 1) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => setCursor(cursor + 1), 850 / speed)
    return () => window.clearTimeout(timer)
  }, [cursor, length, playing, speed])
  if (resource.loading) return <p role="status">{t('loading')}</p>
  if (resource.error) return <Notice error text={t(resource.error)} />
  if (!resource.data?.frames.length) return <Empty>{t('noHistory')}</Empty>
  const frame = resource.data.frames[cursor]
  return (
    <div className="stack">
      <div className="section-head">
        <h2>{resource.data.tableName}</h2>
        <small className="muted">{dateTime(resource.data.at, locale)}</small>
      </div>
      <Board frame={frame} settings={resource.data.settings} local={me!.id} replay />
      <div className="panel replay-controls section-head">
        <div className="button-row">
          <button
            className="button button-primary"
            disabled={cursor >= length - 1}
            onClick={() => setPlaying(!playing)}
          >
            {t(playing ? 'replayPause' : 'replayPlay')}
          </button>
          <button
            className="button button-outline"
            disabled={cursor >= length - 1}
            onClick={() => {
              setPlaying(false)
              setCursor(cursor + 1)
            }}
          >
            {t('replayStep')}
          </button>
          <button
            className="button button-outline"
            onClick={() => {
              setPlaying(false)
              setCursor(0)
            }}
          >
            {t('replayReset')}
          </button>
          <label className="field">
            <span className="sr-only">{t('animationSpeed')}</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value=".5">½×</option>
              <option value="1">1×</option>
              <option value="2">2×</option>
            </select>
          </label>
        </div>
        <span role="status">
          {t('replayOf', { current: cursor + 1, total: length })} · {t('event_' + frame.kind)}
        </span>
      </div>
    </div>
  )
}

function Progress({ badges }: { badges: boolean }) {
  const { t } = useApp()
  const resource = useResource<Stats>('/stats')
  if (resource.loading) return <p role="status">{t('loading')}</p>
  if (resource.error) return <Notice error text={t(resource.error)} />
  if (!resource.data) return <Empty>{t('noData')}</Empty>
  return badges ? (
    <div className="achievements">
      {achievements.map(([label, key, goal]) => {
        const earned = resource.data![key] >= goal
        return (
          <article key={label} className="panel achievement" data-unlocked={earned}>
            <Icon name={earned ? 'spark' : 'lock'} />
            <h3>{t(label)}</h3>
            <small>
              {t(earned ? 'achievementEarned' : 'achievementLocked')} ·{' '}
              {Math.min(goal, resource.data![key])}/{goal}
            </small>
          </article>
        )
      })}
    </div>
  ) : (
    <StatsTiles data={resource.data} />
  )
}

function Leaderboard() {
  const { t, locale } = useApp()
  const [sort, setSort] = useState('blackjacks')
  const [scope, setScope] = useState('all')
  const resource = useResource<{
    leaders: {
      id: string
      name: string
      username: string
      avatar: Avatar
      rounds: number
      score: number
    }[]
  }>('/leaderboard?sort=' + sort + '&scope=' + scope)
  return (
    <section className="panel data-panel stack">
      <div className="filters">
        <label className="field">
          {t('result')}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {['blackjacks', 'rounds', 'longest', 'percentage', 'achievements'].map((key) => (
              <option key={key} value={key}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('players')}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{t('everyone')}</option>
            <option value="friends">{t('friendsOnly')}</option>
          </select>
        </label>
      </div>
      {resource.error && <Notice error text={t(resource.error)} />}
      {resource.loading && <p role="status">{t('loading')}</p>}
      {resource.data?.leaders.length === 0 && <Empty>{t('noLeaders')}</Empty>}
      {resource.data?.leaders.map((person, index) => (
        <div className="list-item" key={person.id}>
          <div className="list-person">
            <span className="rank">{index + 1}</span>
            <AvatarIcon avatar={person.avatar} />
            <div>
              <b>{person.name}</b>
              <small>@{person.username}</small>
            </div>
          </div>
          <b>
            {sort === 'percentage'
              ? Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
                  person.score,
                )
              : person.score.toLocaleString(locale)}
          </b>
        </div>
      ))}
    </section>
  )
}

export default function Account({ path }: { path: string }) {
  const { t } = useApp()
  const tab = path.split('/')[2] || 'profile'
  const title = tab === 'replay' ? 'replay' : accountTabs.includes(tab) ? tab : 'profile'
  return (
    <main className="content-width page" id="main-content">
      <PageTitle title={t(title)} />
      <nav className="tabs" aria-label={t('account')}>
        {accountTabs.map((name) => (
          <a
            key={name}
            href={'#/account/' + name}
            aria-current={(tab === 'replay' ? 'history' : tab) === name ? 'page' : undefined}
          >
            {t(name)}
          </a>
        ))}
      </nav>
      {tab === 'friends' ? (
        <Friends />
      ) : tab === 'preferences' ? (
        <PlayerPreferences />
      ) : tab === 'history' ? (
        <RoundHistory />
      ) : tab === 'leaders' ? (
        <Leaderboard />
      ) : tab === 'replay' ? (
        <Replay key={path} id={path.split('/')[3]} />
      ) : tab === 'stats' || tab === 'achievements' ? (
        <Progress badges={tab === 'achievements'} />
      ) : (
        <MyProfile edit={path.endsWith('/edit')} />
      )}
    </main>
  )
}
