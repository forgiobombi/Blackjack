import { Suspense, lazy, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DEFAULT_TABLE } from '../../../packages/protocol/rules.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import type { Avatar, TableSummary } from '../../../packages/protocol/types.ts'
import { api, codeOf } from './api.ts'
import { chipCount, dateTime } from './i18n.ts'
import { RulesList } from './public.tsx'
import { go, useApp, useResource } from './state.tsx'
import { TableFields, TableForm } from './table-form.tsx'
import { AvatarIcon, Empty, Icon, Modal, Notice, PageTitle } from './ui.tsx'

const Invite = lazy(() => import('./invitations.tsx'))
const tabItems = [
  ['', 'admin'],
  ['create', 'createTable'],
  ['manage', 'manage'],
  ['reports', 'reports'],
  ['audit', 'audit'],
  ['health', 'infrastructure'],
]
const rootItems = [
  ['users', 'users'],
  ['settings', 'system'],
]

type Status = {
  id: string
  seats: number
  spectators: number
  connections: number
  phase: string
  expiresAt: number
  paused: boolean
  recovering: boolean
  unavailable?: boolean
}
type Overview = {
  users: number
  rounds: number
  active: number
  lastCleanup: number | null
  tables: TableSummary[]
  statuses: Status[]
  sampled: number
  auth: boolean
  database: boolean
}

function Tables({ overview, minimal = false }: { overview: Overview; minimal?: boolean }) {
  const { t, me, locale } = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('active')
  const tables = overview.tables.filter(
    (item) =>
      item.settings.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || item.status === 'closed' ? filter !== 'active' : filter === 'active'),
  )
  return (
    <div className="panel data-panel stack">
      <div className="section-head">
        <h2>{t('manage')}</h2>
        <a className="button button-primary" href="#/admin/create">
          <Icon name="plus" size={17} />
          {t('createTable')}
        </a>
      </div>
      {!minimal && (
        <div className="filters">
          <label className="field">
            {t('tableSearch')}
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="field">
            {t('status')}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="active">{t('active')}</option>
              <option value="all">{t('all')}</option>
              <option value="closed">{t('closedStatus')}</option>
            </select>
          </label>
        </div>
      )}
      {!tables.length && <Empty>{t('noTables')}</Empty>}
      {tables.map((item) => {
        const live = overview.statuses.find((row) => row.id === item.id)
        return (
          <div className="list-item" key={item.id}>
            <div>
              <b>{item.settings.name}</b>
              <small>
                {t(
                  item.status === 'closed'
                    ? 'closedStatus'
                    : item.status === 'closing'
                      ? 'closing'
                      : 'active',
                )}{' '}
                · {dateTime(item.createdAt, locale)}
                {live &&
                  !live.unavailable &&
                  ' · ' + t('availability', { used: live.seats, max: item.settings.maxPlayers })}
              </small>
            </div>
            <div className="button-row">
              {item.status !== 'closed' && (
                <a className="button button-ghost" href={'#/table/' + item.id}>
                  {t('open')}
                </a>
              )}
              {(me!.role === 'superadmin' || me!.id === item.ownerId) && (
                <a className="button button-outline" href={'#/admin/table/' + item.id}>
                  {t('details')} <Icon name="arrow" size={15} />
                </a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function OverviewPage({ page }: { page: string }) {
  const { t, me, locale } = useApp()
  const remote = useResource<Overview>('/admin')
  const data = remote.data
  if (remote.loading) return <p role="status">{t('loading')}</p>
  if (remote.error) return <Notice error text={t(remote.error)} />
  if (!data) return <Empty>{t('noData')}</Empty>
  const open = data.statuses.filter((row) => !row.unavailable)
  const metrics = [
    ...(me!.role === 'superadmin' ? [['registered', data.users]] : []),
    ['activeTables', data.active],
    ['rounds', data.rounds],
    ['waitingTables', open.filter((row) => row.phase === 'waiting' || row.paused).length],
    [
      'liveGames',
      open.filter((row) => !['waiting', 'complete', 'closed'].includes(row.phase)).length,
    ],
    ['activeUsers', open.reduce((sum, row) => sum + row.seats, 0)],
    ['connections', open.reduce((sum, row) => sum + row.connections, 0)],
    ['spectators', open.reduce((sum, row) => sum + row.spectators, 0)],
    ['reconciliations', open.filter((row) => row.recovering).length],
  ]
  if (page === 'manage') return <Tables overview={data} />
  return (
    <div className="stack">
      <div className="section-head">
        <span className="muted">{t('sampled', { n: data.sampled })}</span>
        <button className="button button-outline" onClick={remote.reload}>
          {t('refresh')}
        </button>
      </div>
      <div className="stat-grid">
        {metrics.map(([label, value]) => (
          <div className="panel stat" key={label}>
            <span>{t(String(label))}</span>
            <b>{Number(value).toLocaleString(locale)}</b>
          </div>
        ))}
      </div>
      {page === 'health' ? (
        <>
          <section className="panel data-panel">
            <h2>{t('infrastructure')}</h2>
            {(
              [
                ['database', data.database],
                ['authService', data.auth],
              ] as const
            ).map(([label, ok]) => (
              <div className="list-item" key={label}>
                <b>{t(label)}</b>
                <span className="badge">{t(ok ? 'healthy' : 'unavailable')}</span>
              </div>
            ))}
            <div className="list-item">
              <b>{t('lastCleanup')}</b>
              <span>{data.lastCleanup ? dateTime(data.lastCleanup, locale) : '—'}</span>
            </div>
            <a
              className="button button-outline"
              href="https://dash.cloudflare.com/"
              target="_blank"
              rel="noreferrer"
            >
              {t('providerMetrics')} <Icon name="arrow" size={16} />
            </a>
          </section>
        </>
      ) : (
        <Tables overview={data} minimal />
      )}
    </div>
  )
}

function CreateTable() {
  const { t } = useApp()
  const defaults = useResource<{ defaults: TableSettings | null }>('/table-defaults')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useRef(crypto.randomUUID())
  async function create(settings: TableSettings) {
    setBusy(true)
    setError('')
    try {
      const { table } = await api<{ table: TableSummary }>('/tables', {
        body: { id: id.current, settings },
      })
      go('/table/' + table.id)
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  if (defaults.loading) return <p role="status">{t('loading')}</p>
  return (
    <>
      {error && <Notice error text={t(error)} />}
      <TableForm
        label={t('createTable')}
        initial={
          defaults.data?.defaults
            ? { ...defaults.data.defaults, name: '', description: '' }
            : undefined
        }
        busy={busy}
        submit={(settings) => void create(settings)}
      />
    </>
  )
}

type Person = {
  id: string
  name: string
  username: string
  avatar: Avatar
  banned: number
  muted: number
}
function Details({ id }: { id: string }) {
  const { t, me, locale, toast } = useApp()
  const remote = useResource<{ table: TableSummary }>('/tables/' + id)
  const status = useResource<Status>('/tables/' + id + '/status')
  const people = useResource<{ people: Person[] }>('/tables/' + id + '/people')
  const [modal, setModal] = useState<'invite' | 'close' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const item = remote.data?.table
  const phase = status.data?.phase
  async function command(action: string, extra: object = {}) {
    setBusy(true)
    setError('')
    try {
      await api('/tables/' + id + '/admin', { body: { id: crypto.randomUUID(), action, ...extra } })
      remote.reload()
      status.reload()
      people.reload()
      setModal(null)
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  if (remote.loading) return <p role="status">{t('loading')}</p>
  if (remote.error || !item) return <Notice error text={t(remote.error ?? 'not_found')} />
  const closed = item.status === 'closed'
  const between = phase === 'waiting' || phase === 'complete'
  return (
    <div className="stack">
      {error && <Notice error text={t(error)} />}
      <section className="panel data-panel stack">
        <div className="section-head">
          <div>
            <h2>{item.settings.name}</h2>
            <p className="muted">{item.settings.description}</p>
          </div>
          <span className="badge">
            {t(
              closed
                ? 'closedStatus'
                : status.data?.paused
                  ? 'paused'
                  : item.status === 'closing'
                    ? 'closing'
                    : 'active',
            )}
          </span>
        </div>
        {status.error && <Notice error text={t(status.error)} />}
        {status.data && (
          <div className="badge-row">
            <span className="badge">
              {t('connections')} · {status.data.connections}
            </span>
            <span className="badge">
              {t('spectators')} · {status.data.spectators}
            </span>
            {!closed && (
              <span className="badge">
                {t('expires', { date: dateTime(status.data.expiresAt, locale) })}
              </span>
            )}
          </div>
        )}
        {!closed && (
          <div className="button-row">
            <a className="button button-primary" href={'#/table/' + id}>
              {t('open')}
            </a>
            <button className="button button-outline" onClick={() => setModal('invite')}>
              {t('inviteFriends')}
            </button>
            <button
              className="button button-outline"
              disabled={busy || !between || item.status === 'closing'}
              onClick={() => void command(status.data?.paused ? 'resume' : 'pause')}
            >
              {t(status.data?.paused ? 'resume' : 'pause')}
            </button>
            <button
              className="button button-outline"
              disabled={busy || item.status === 'closing'}
              onClick={() => void command('joining', { enabled: 1 })}
            >
              {t('joinOn')}
            </button>
            <button
              className="button button-outline"
              disabled={busy || item.status === 'closing'}
              onClick={() => void command('joining', { enabled: 0 })}
            >
              {t('joinOff')}
            </button>
            <button
              className="button button-ghost"
              disabled={busy || item.status === 'closing'}
              onClick={() => setModal('close')}
            >
              {t('closeTable')}
            </button>
          </div>
        )}
        <details>
          <summary>{t('cityRules')}</summary>
          <RulesList settings={item.settings} />
        </details>
      </section>
      <section className="panel data-panel">
        <h2>{t('moderation')}</h2>
        {people.error && <Notice error text={t(people.error)} />}
        {people.data?.people
          .filter((person) => person.id !== item.ownerId)
          .map((person) => (
            <div className="list-item" key={person.id}>
              <div className="list-person">
                <AvatarIcon avatar={person.avatar} />
                <div>
                  <b>{person.name}</b>
                  <small>@{person.username}</small>
                </div>
              </div>
              {!closed && person.id !== me!.id && (
                <div className="button-row">
                  {!person.banned && (
                    <>
                      <button
                        className="button button-ghost"
                        disabled={busy}
                        onClick={() => void command('remove', { user: person.id })}
                      >
                        {t('remove')}
                      </button>
                      <button
                        className="button button-outline"
                        disabled={busy}
                        onClick={() =>
                          void command(person.muted ? 'unmute' : 'mute', { user: person.id })
                        }
                      >
                        {t(person.muted ? 'unmute' : 'mute')}
                      </button>
                    </>
                  )}
                  <button
                    className="button button-outline"
                    disabled={busy}
                    onClick={() =>
                      void command(person.banned ? 'unban' : 'ban', { user: person.id })
                    }
                  >
                    {t(person.banned ? 'unban' : 'ban')}
                  </button>
                </div>
              )}
            </div>
          ))}
        {people.data &&
          people.data.people.filter((person) => person.id !== item.ownerId).length === 0 && (
            <Empty>{t('noData')}</Empty>
          )}
      </section>
      {!closed && between && item.status === 'open' && (
        <details>
          <summary>{t('settings')}</summary>
          <TableForm
            key={JSON.stringify(item.settings)}
            initial={item.settings}
            label={t('save')}
            busy={busy}
            submit={(settings) => void command('settings', { settings })}
          />
        </details>
      )}
      {modal === 'invite' && (
        <Suspense fallback={<span role="status">{t('loading')}</span>}>
          <Invite id={id} owner close={() => setModal(null)} />
        </Suspense>
      )}
      {modal === 'close' && (
        <Modal title={t('closeTable')} t={t} close={() => setModal(null)}>
          <p>{t('closeConfirm')}</p>
          <div className="button-row">
            <button className="button button-outline" onClick={() => setModal(null)}>
              {t('cancel')}
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void command('close')}
            >
              {t('closeTable')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

type User = {
  id: string
  username: string
  name: string
  role: 'player' | 'admin' | 'superadmin'
  suspended: number
  balance: number
}
function Users() {
  const { t, locale, toast } = useApp()
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [adjust, setAdjust] = useState<User>()
  const [busy, setBusy] = useState(false)
  const remote = useResource<{ users: User[] }>('/admin/users?q=' + encodeURIComponent(query))
  async function action(target: string, value: string, extra: object = {}) {
    setBusy(true)
    setError('')
    try {
      await api('/admin/users/' + target, {
        body: { id: crypto.randomUUID(), action: value, ...extra },
      })
      remote.reload()
      setAdjust(undefined)
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setQuery(String(new FormData(event.currentTarget).get('q') ?? ''))
  }
  function chips(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void action(adjust!.id, 'adjust', {
      chips: Number(data.get('chips')),
      reason: data.get('reason'),
    })
  }
  return (
    <section className="panel data-panel stack">
      <form className="filters" onSubmit={lookup}>
        <label className="field">
          {t('findUser')}
          <input name="q" maxLength={20} type="search" />
        </label>
        <button className="button button-outline">{t('find')}</button>
      </form>
      {remote.error && <Notice error text={t(remote.error)} />}
      {error && !adjust && <Notice error text={t(error)} />}
      {remote.data?.users.length === 0 && <Empty>{t('noUsers')}</Empty>}
      {remote.data?.users.map((user) => (
        <div className="list-item" key={user.id}>
          <div>
            <b>{user.name}</b>
            <small>
              @{user.username} · {t(user.role)} · {chipCount(user.balance, locale)} {t('chips')}
              {Boolean(user.suspended) && ' · ' + t('suspended')}
            </small>
          </div>
          <div className="button-row">
            {user.role !== 'superadmin' && (
              <>
                <button
                  className="button button-outline"
                  disabled={busy}
                  onClick={() =>
                    void action(user.id, user.role === 'player' ? 'promote' : 'demote')
                  }
                >
                  {t(user.role === 'player' ? 'promote' : 'demote')}
                </button>
                <button
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => void action(user.id, user.suspended ? 'restore' : 'suspend')}
                >
                  {t(user.suspended ? 'restore' : 'suspend')}
                </button>
              </>
            )}
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => {
                setError('')
                setAdjust(user)
              }}
            >
              {t('adjust')}
            </button>
          </div>
        </div>
      ))}
      {adjust && (
        <Modal title={t('adjust') + ' · ' + adjust.name} t={t} close={() => setAdjust(undefined)}>
          {error && <Notice error text={t(error)} />}
          <form className="stack" onSubmit={chips}>
            <label className="field">
              {t('chips')}
              <input name="chips" type="number" min="-100000" max="100000" required />
            </label>
            <label className="field">
              {t('reason')}
              <input name="reason" minLength={4} maxLength={140} required />
            </label>
            <button className="button button-primary" disabled={busy}>
              {t('save')}
            </button>
          </form>
        </Modal>
      )}
    </section>
  )
}

function Activity({ reports }: { reports: boolean }) {
  const { t, locale } = useApp()
  const data = useResource<{
    reports?: {
      id: string
      status: string
      name: string
      at: number
      excerpt: string
      reason: string
    }[]
    logs?: { id: string; action: string; target: string; name?: string; at: number }[]
  }>(reports ? '/admin/reports' : '/admin/audit')
  const [error, setError] = useState('')
  async function review(id: string) {
    try {
      await api('/admin/reports/' + id, { method: 'POST' })
      data.reload()
      setError('')
    } catch (e) {
      setError(codeOf(e))
    }
  }
  if (data.loading) return <p role="status">{t('loading')}</p>
  if (data.error) return <Notice error text={t(data.error)} />
  return (
    <div className="panel data-panel stack">
      {error && <Notice error text={t(error)} />}
      {reports ? (
        data.data?.reports?.length ? (
          data.data.reports.map((item) => (
            <article className="list-item" key={item.id}>
              <div>
                <b>
                  {item.name} · {dateTime(item.at, locale)}
                </b>
                <p>{item.excerpt}</p>
                <small>{item.reason}</small>
              </div>
              {item.status === 'open' ? (
                <button className="button button-outline" onClick={() => void review(item.id)}>
                  {t('markReviewed')}
                </button>
              ) : (
                <span className="badge">{t('reviewed')}</span>
              )}
            </article>
          ))
        ) : (
          <Empty>{t('noReports')}</Empty>
        )
      ) : data.data?.logs?.length ? (
        data.data.logs.map((item) => (
          <div className="list-item" key={item.id}>
            <div>
              <b>{t(item.action)}</b>
              <small>
                {item.name ?? t('system')} · {item.target}
              </small>
            </div>
            <time dateTime={new Date(item.at).toISOString()}>{dateTime(item.at, locale)}</time>
          </div>
        ))
      ) : (
        <Empty>{t('noAudit')}</Empty>
      )}
    </div>
  )
}

type System = {
  starting: number
  refill: number
  below: number
  minutes: number
  defaults: TableSettings | null
}
function GlobalSettings({ initial }: { initial: System }) {
  const { t, toast } = useApp()
  const [value, setValue] = useState(initial)
  const [defaults, setDefaults] = useState(
    initial.defaults ?? { ...DEFAULT_TABLE, name: 'Blackjack Royale' },
  )
  const [custom, setCustom] = useState(Boolean(initial.defaults))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/admin/settings', {
        method: 'PATCH',
        body: { ...value, defaults: custom ? defaults : null },
      })
      toast(t('updated'))
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="panel form-panel form-grid" onSubmit={(e) => void submit(e)}>
      {error && (
        <div className="form-wide">
          <Notice error text={t(error)} />
        </div>
      )}
      {(
        [
          ['starting', 'startingChips', 100, 100000],
          ['refill', 'refillChips', 100, 10000],
          ['below', 'refillBelow', 0, 10000],
          ['minutes', 'refillMins', 60, 10080],
        ] as const
      ).map(([key, label, min, max]) => (
        <label className="field" key={key}>
          {t(label)}
          <input
            value={value[key]}
            onChange={(e) => setValue({ ...value, [key]: Number(e.target.value) })}
            min={min}
            max={max}
            type="number"
            required
          />
        </label>
      ))}
      <label className="check-field form-wide">
        <input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
        {t('tableDefaults')}
      </label>
      {custom && (
        <>
          <h2 className="form-wide">{t('defaults')}</h2>
          <TableFields value={defaults} setValue={setDefaults} />
        </>
      )}
      <div className="form-wide">
        <button className="button button-primary" disabled={busy}>
          {t('save')}
        </button>
      </div>
    </form>
  )
}
function SystemPage() {
  const { t } = useApp()
  const data = useResource<System>('/admin/settings')
  return data.loading ? (
    <p role="status">{t('loading')}</p>
  ) : data.error || !data.data ? (
    <Notice error text={t(data.error ?? 'unavailable')} />
  ) : (
    <GlobalSettings initial={data.data} />
  )
}

export default function Admin({ path }: { path: string }) {
  const { t, me } = useApp()
  const page = path.split('/')[2] || ''
  const tabs = me!.role === 'superadmin' ? [...tabItems, ...rootItems] : tabItems
  const title = page === 'table' ? 'details' : (tabs.find(([key]) => key === page)?.[1] ?? 'admin')
  return (
    <main className="content-width page" id="main-content">
      <PageTitle title={t(title)} />
      <nav className="tabs" aria-label={t('admin')}>
        {tabs.map(([key, label]) => (
          <a
            key={key}
            aria-current={(page === 'table' ? 'manage' : page) === key ? 'page' : undefined}
            href={'#/admin' + (key ? '/' + key : '')}
          >
            {t(label)}
          </a>
        ))}
      </nav>
      {page === 'create' ? (
        <CreateTable />
      ) : page === 'table' ? (
        <Details key={path} id={path.split('/')[3]} />
      ) : page === 'users' ? (
        <Users />
      ) : page === 'settings' ? (
        <SystemPage />
      ) : ['reports', 'audit'].includes(page) ? (
        <Activity key={page} reports={page === 'reports'} />
      ) : (
        <OverviewPage page={page} />
      )}
    </main>
  )
}
