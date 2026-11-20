import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { TableSummary } from '../../../packages/protocol/types.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import { api, apiOrigin, beginAuth, codeOf, siteName } from './api.ts'
import { chipCount } from './i18n.ts'
import { go, useApp, useResource } from './state.tsx'
import { Empty, Icon, Notice, PageTitle } from './ui.tsx'

export function JoinForm({ inline = false }: { inline?: boolean }) {
  const { t } = useApp()
  const [code, setCode] = useState('')
  function submit(event: FormEvent) {
    event.preventDefault()
    if (code.trim()) go('/join/' + encodeURIComponent(code.trim().toUpperCase()))
  }
  return (
    <form className={'code-form' + (inline ? ' inline-code' : '')} onSubmit={submit}>
      <label className="code-input">
        <Icon name="key" size={18} />
        <span className="sr-only">{t('inviteCode')}</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('invitePlaceholder')}
          maxLength={8}
          minLength={8}
          pattern="[A-Za-z2-9]{8}"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <button className="button button-outline" type="submit">
        {t('codeContinue')} <Icon name="arrow" size={17} />
      </button>
    </form>
  )
}

export function Landing() {
  const { t, me } = useApp()
  return (
    <main id="main-content" className="home">
      <section className="hero">
        <img
          className="hero-photo"
          src={import.meta.env.BASE_URL + 'lounge.webp'}
          alt=""
          width="1300"
          height="867"
          fetchPriority="high"
        />
        <div className="hero-inner content-width">
          <div className="hero-content">
            <div className="hero-eyebrow">
              <span></span>
              {t('heroTop')}
            </div>
            <h1>
              {siteName === 'Blackjack Royale' ? (
                <>
                  {t('heroA')} <em>{t('heroB')}</em>
                </>
              ) : (
                siteName
              )}
            </h1>
            <p>{t('heroText')}</p>
            <div className="hero-actions">
              <a className="button button-primary" href={me ? '#/lobby' : '#/signin'}>
                {t('enter')} <Icon name="arrow" size={19} />
              </a>
              <a href="#/rules" className="button button-ghost">
                <Icon name="cards" size={20} />
                {t('rules')}
              </a>
            </div>
            <small>
              <Icon name="chip" size={15} />
              {t('freeChips')}
            </small>
          </div>
        </div>
        <div className="hero-code">
          <div className="content-width hero-code-inner">
            <div>
              <Icon name="key" size={21} />
              <span>{t('codeHint')}</span>
            </div>
            <JoinForm inline />
          </div>
        </div>
      </section>
      <section className="home-intro content-width">
        <div className="home-intro-heading">
          <h2>{t('howTitle')}</h2>
          <span>{t('howText')}</span>
        </div>
        <div className="home-grid">
          {[
            ['lock', 'stepInvite', 'stepInviteText'],
            ['people', 'stepSeat', 'stepSeatText'],
            ['cards', 'stepPlay', 'stepPlayText'],
          ].map(([icon, title, body]) => (
            <article key={icon} className="home-step">
              <div className="step-icon">
                <Icon name={icon} size={25} />
              </div>
              <h3>{t(title)}</h3>
              <p>{t(body)}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

export function AccountGate({
  destination = '/lobby',
  register = false,
  invite = false,
}: {
  destination?: string
  register?: boolean
  invite?: boolean
}) {
  const { t, locale } = useApp()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function enter(mode: 'login' | 'register') {
    setBusy(true)
    setError('')
    try {
      await beginAuth(mode, destination, locale)
    } catch (e) {
      setError(codeOf(e))
      setBusy(false)
    }
  }
  return (
    <main id="main-content" className="content-width page center-page">
      <section className="gate panel">
        <span className="gate-icon">
          <Icon name={invite ? 'key' : 'lock'} size={25} />
        </span>
        <h1>{t(invite ? 'inviteTitle' : register ? 'register' : 'signIn')}</h1>
        <p>{t(invite ? 'inviteSignIn' : 'dashboardText')}</p>
        {(!apiOrigin || error) && <Notice error text={t(error || 'setupService')} />}
        <div className="button-row">
          <button
            className="button button-primary"
            disabled={busy || !apiOrigin}
            onClick={() => void enter(register ? 'register' : 'login')}
          >
            {t(register ? 'register' : 'signIn')} <Icon name="arrow" size={18} />
          </button>
          <button
            className="button button-outline"
            disabled={busy || !apiOrigin}
            onClick={() => void enter(register ? 'login' : 'register')}
          >
            {t(register ? 'signIn' : 'register')}
          </button>
        </div>
        {!invite && <JoinForm />}
      </section>
    </main>
  )
}

export function RulesList({ settings }: { settings: TableSettings }) {
  const { t } = useApp()
  const r = settings.rules
  const fields = [
    [t('decks'), r.decks],
    [t('payout'), r.payout],
    [t('soft17'), t(r.soft17)],
    [t('double'), t(r.double === '9-11' ? 'hard9' : r.double === '10-11' ? 'hard10' : r.double)],
    [t('splitRule'), t(r.split)],
    [t('maxHands'), r.maxHands],
    [t('surrender'), t(r.surrender === 'early' ? 'earlyRule' : r.surrender)],
    [t('insurance'), r.insurance ? '✓' : '—'],
    [t('holeCard'), t(r.holeCard)],
    ...(r.holeCard === 'european'
      ? [[t('dealerBlackjack'), t(r.dealerBlackjack === 'all' ? 'allBets' : 'original')]]
      : []),
    [t('doubleAfterSplit'), r.doubleAfterSplit ? '✓' : '—'],
    [t('resplit'), r.resplit ? '✓' : '—'],
    [t('resplitAces'), r.resplitAces ? '✓' : '—'],
    [t('hitSplitAces'), r.hitSplitAces ? '✓' : '—'],
    [t('penetration'), r.penetration + '%'],
    [t('betTime'), settings.bettingSeconds],
    [t('turnTime'), settings.turnSeconds],
    [t('betRange', { min: settings.minBet, max: settings.maxBet }), ''],
  ]
  return (
    <dl className="rules-list">
      {fields.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          {value !== '' && <dd>{value}</dd>}
        </div>
      ))}
    </dl>
  )
}

type Preview = {
  table: TableSummary
  seats: number
  canSeat: boolean
  spectators: number
  joined: boolean
}
export function Invitation({ value, direct = false }: { value: string; direct?: boolean }) {
  const { t } = useApp()
  const [preview, setPreview] = useState<Preview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const payload = direct ? { tableId: value } : { invite: value }
  useEffect(() => {
    let current = true
    api<Preview>('/join/preview', { body: direct ? { tableId: value } : { invite: value } }).then(
      (result) => {
        if (current) setPreview(result)
      },
      (e) => {
        if (current) setError(codeOf(e))
      },
    )
    return () => {
      current = false
    }
  }, [direct, value])
  async function join() {
    setBusy(true)
    setError('')
    try {
      const { table } = await api<{ table: TableSummary }>('/join', { body: payload })
      go('/table/' + table.id)
    } catch (e) {
      setError(codeOf(e))
      setBusy(false)
    }
  }
  return (
    <main id="main-content" className="content-width page center-page">
      <section className="gate panel invite-gate">
        <span className="gate-icon">
          <Icon name="key" size={25} />
        </span>
        <h1>{preview?.table.settings.name ?? t('preview')}</h1>
        {error && <Notice error text={t(error)} />}
        {!preview && !error && <p role="status">{t('loading')}</p>}
        {preview && (
          <>
            <p>{preview.table.settings.description}</p>
            <div className="badge-row">
              <span className="badge">
                <Icon name="people" size={15} />
                {t('availability', { used: preview.seats, max: preview.table.settings.maxPlayers })}
              </span>
              <span className="badge">
                {t(preview.table.settings.private ? 'privateTable' : 'publicTable')}
              </span>
            </div>
            <details>
              <summary>{t('cityRules')}</summary>
              <RulesList settings={preview.table.settings} />
            </details>
            <button className="button button-primary" onClick={() => void join()} disabled={busy}>
              {t(preview.canSeat || preview.joined ? 'enterTable' : 'watch')}{' '}
              <Icon name="arrow" size={18} />
            </button>
          </>
        )}
        {!preview && error && <JoinForm />}
      </section>
    </main>
  )
}

export function Lobby() {
  const { me, t, locale } = useApp()
  const remote = useResource<{ tables: TableSummary[] }>('/tables')
  return (
    <main id="main-content" className="content-width page">
      <PageTitle title={t('dashboardTitle')} subtitle={t('dashboardText')}>
        <a href="#/account/profile" className="wallet-chip">
          <Icon name="chip" />
          <b>{chipCount(me?.balance ?? 0, locale)}</b> {t('chips')}
        </a>
        {me?.role !== 'player' && (
          <a className="button button-primary" href="#/admin/create">
            <Icon name="plus" />
            {t('createTable')}
          </a>
        )}
      </PageTitle>
      <section className="lobby-invite panel">
        <div>
          <span className="step-icon">
            <Icon name="key" size={24} />
          </span>
          <h2>{t('joinTable')}</h2>
        </div>
        <JoinForm />
      </section>
      <div className="section-head lobby-head">
        <h2>{t('activeTables')}</h2>
        <button className="button button-ghost" onClick={remote.reload}>
          {t('refresh')}
        </button>
      </div>
      {remote.error && <Notice error text={t(remote.error)} />}
      {remote.loading && <p role="status">{t('loading')}</p>}
      {remote.data?.tables.length === 0 && <Empty>{t('noTables')}</Empty>}
      <div className="table-catalog">
        {remote.data?.tables.map((table) => (
          <article className={'table-tile panel theme-' + table.settings.theme} key={table.id}>
            <div className="tile-felt" aria-hidden="true">
              <span>♠</span>
            </div>
            <div className="tile-content">
              <div className="badge-row">
                <span className="badge">
                  {t(table.settings.private ? 'privateTable' : 'publicTable')}
                </span>
                <span className="badge">
                  <Icon name="people" size={15} />
                  {table.settings.maxPlayers}
                </span>
              </div>
              <h3>{table.settings.name}</h3>
              <p>
                {table.settings.description ||
                  t('betRange', { min: table.settings.minBet, max: table.settings.maxBet })}
              </p>
              <a
                className="button button-outline"
                href={
                  table.status === 'closing' ? '#/table/' + table.id : '#/join/table/' + table.id
                }
              >
                {t(table.status === 'closing' ? 'closing' : 'enterTable')}{' '}
                <Icon name="arrow" size={16} />
              </a>
            </div>
          </article>
        ))}
      </div>
    </main>
  )
}

export function Info({ page }: { page: 'rules' | 'privacy' | 'terms' | 'help' }) {
  const { t } = useApp()
  const copy = {
    rules: [
      ['totalsTitle', 'totalsCopy'],
      ['decisionTitle', 'decisionCopy'],
      ['payoutTitle', 'payoutCopy'],
      ['variantTitle', 'variantCopy'],
    ],
    help: [
      ['joinTable', 'helpIntro'],
      ['reconnecting', 'helpConnection'],
      ['closing', 'helpIdle'],
    ],
    privacy: [
      ['privacy', 'privacyCopy'],
      ['history', 'privacyRetention'],
    ],
    terms: [['freeChips', 'termsCopy']],
  }[page]
  return (
    <main id="main-content" className="content-width page reading-page">
      <PageTitle title={t(page)} subtitle={page === 'rules' ? t('rulesIntro') : undefined} />
      <div className="reading-grid">
        {copy.map(([title, body]) => (
          <section className="panel prose" key={body}>
            <h2>{t(title)}</h2>
            <p>{t(body)}</p>
          </section>
        ))}
      </div>
      <a className="button button-outline" href="#/lobby">
        {t('enter')} <Icon name="arrow" size={18} />
      </a>
    </main>
  )
}
