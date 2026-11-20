import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource/cormorant-garamond/latin-600.css'
import '@fontsource/cormorant-garamond/latin-600-italic.css'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Locale, Profile } from '../../../packages/protocol/types.ts'
import { api, codeOf, finishAuth, getSession, signOut, siteName } from './api.ts'
import { initialLocale, translator } from './i18n.ts'
import { State, go, route, useApp } from './state.tsx'
import { AccountGate, Info, Invitation, Landing, Lobby } from './public.tsx'
import { Icon, Notice } from './ui.tsx'
import './style.css'

const Game = lazy(() => import('./game.tsx'))
const Account = lazy(() => import('./account.tsx'))
const Admin = lazy(() => import('./admin.tsx'))

function AuthReturn({ value }: { value: string }) {
  const { t } = useApp()
  const [error, setError] = useState('')
  useEffect(() => {
    finishAuth(value).then(
      (next) => go(next, true),
      (e) => setError(codeOf(e)),
    )
  }, [value])
  return (
    <main id="main-content" className="content-width page center-page">
      <div className="panel gate">
        {error ? (
          <>
            <Notice error text={t(error)} />
            <a className="button button-primary" href="#/signin">
              {t('signIn')}
            </a>
          </>
        ) : (
          <p role="status">{t('loading')}</p>
        )}
      </div>
    </main>
  )
}

function SetupProfile({ reload }: { reload: () => void }) {
  const { t, setMe } = useApp()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const username = new FormData(event.currentTarget).get('username')
    setBusy(true)
    setError('')
    try {
      setMe(await api<Profile>('/me/setup', { body: { username } }))
      reload()
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main id="main-content" className="content-width page center-page">
      <div className="panel gate">
        <h1>{t('setupProfile')}</h1>
        <p>{t('setupHint')}</p>
        {error && <Notice error text={t(error)} />}
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            {t('username')}
            <input
              name="username"
              required
              minLength={3}
              maxLength={20}
              pattern="[a-zA-Z0-9_]+"
              autoComplete="username"
            />
          </label>
          <button className="button button-primary" disabled={busy}>
            {t('save')}
          </button>
        </form>
      </div>
    </main>
  )
}

function Header({ path, authenticated }: { path: string; authenticated: boolean }) {
  const { t, me, locale, selectLocale } = useApp()
  const [menu, setMenu] = useState(false)
  useEffect(() => setMenu(false), [path])
  const links = authenticated
    ? [
        ['/lobby', 'lobby'],
        ['/account/friends', 'friends'],
        ['/account/history', 'history'],
        ['/rules', 'rules'],
      ]
    : [
        ['/', 'home'],
        ['/rules', 'rules'],
        ['/help', 'help'],
      ]
  return (
    <header className="site-header">
      <div className="header-inner content-width">
        <a href="#/" className="wordmark" aria-label={siteName}>
          <img src={import.meta.env.BASE_URL + 'favicon.svg'} alt="" width="37" height="37" />
          <span>{siteName}</span>
        </a>
        <nav
          id="main-nav"
          className={'main-nav' + (menu ? ' nav-open' : '')}
          aria-label={t('menu')}
        >
          {links.map(([url, label]) => (
            <a aria-current={path === url ? 'page' : undefined} key={url} href={'#' + url}>
              {t(label)}
            </a>
          ))}
          {me && me.role !== 'player' && (
            <a aria-current={path.startsWith('/admin') ? 'page' : undefined} href="#/admin">
              {t('admin')}
            </a>
          )}
        </nav>
        <div className="header-actions">
          <label className="locale-control">
            <Icon name="globe" size={18} />
            <span className="sr-only">{t('language')}</span>
            <select value={locale} onChange={(e) => selectLocale(e.target.value as Locale)}>
              <option value="en">EN</option>
              <option value="it">IT</option>
            </select>
          </label>
          {authenticated ? (
            <a className="button button-outline header-login" href="#/account/profile">
              {t('account')}
            </a>
          ) : (
            <a className="button button-outline header-login" href="#/signin">
              {t('signIn')} <Icon name="arrow" size={16} />
            </a>
          )}
          <button
            className="icon-button nav-toggle"
            aria-label={t('menu')}
            aria-controls="main-nav"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? 'close' : 'menu'} />
          </button>
        </div>
      </div>
    </header>
  )
}

function Footer() {
  const { t } = useApp()
  return (
    <footer className="footer">
      <div className="content-width footer-inner">
        <a className="wordmark" href="#/">
          <span className="footer-spade">♠</span>
          <span>{siteName}</span>
        </a>
        <span>{t('freeChips')}</span>
        <nav>
          <a href="#/help">{t('help')}</a>
          <a href="#/privacy">{t('privacy')}</a>
          <a href="#/terms">{t('terms')}</a>
        </nav>
      </div>
    </footer>
  )
}

function App() {
  const [path, setPath] = useState(route)
  const [logged, setLogged] = useState(() => Boolean(getSession()))
  const [locale, setLocale] = useState(initialLocale)
  const [me, setMe] = useState<Profile | null>(null)
  const [profileError, setProfileError] = useState('')
  const [profileVersion, setProfileVersion] = useState(0)
  const [message, setMessage] = useState('')
  const t = useMemo(() => translator(locale), [locale])
  useEffect(() => {
    function changed() {
      const next = route()
      if (next !== path) {
        setPath(next)
        window.scrollTo(0, 0)
      }
    }
    function loggedChanged() {
      setLogged(Boolean(getSession()))
    }
    window.addEventListener('hashchange', changed)
    window.addEventListener('storage', loggedChanged)
    window.addEventListener('royale-session', loggedChanged)
    return () => {
      window.removeEventListener('hashchange', changed)
      window.removeEventListener('storage', loggedChanged)
      window.removeEventListener('royale-session', loggedChanged)
    }
  }, [path])
  useEffect(() => {
    if (!logged) {
      setMe(null)
      setProfileError('')
      return
    }
    let active = true
    setProfileError('')
    api<Profile>('/me').then(
      (profile) => {
        if (!active) return
        setMe(profile)
        if (!localStorage.getItem('royale.locale')) setLocale(profile.preferences.locale)
      },
      (error) => {
        if (active) setProfileError(codeOf(error))
      },
    )
    return () => {
      active = false
    }
  }, [logged, profileVersion])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 3300)
    return () => window.clearTimeout(timer)
  }, [message])
  function selectLocale(language: Locale) {
    setLocale(language)
    localStorage.setItem('royale.locale', language)
    if (me) {
      setMe({ ...me, preferences: { ...me.preferences, locale: language } })
      void api<Profile>('/me/preferences', {
        method: 'PATCH',
        body: { ...me.preferences, locale: language },
      }).catch(() => {})
    }
  }
  let page: ReactNode
  const invite = path.startsWith('/join/')
  if (path === '/') page = <Landing />
  else if (['/rules', '/help', '/privacy', '/terms'].includes(path))
    page = <Info page={path.slice(1) as 'rules' | 'help' | 'privacy' | 'terms'} />
  else if (path.startsWith('/auth/return/'))
    page = <AuthReturn value={path.slice('/auth/return/'.length)} />
  else if (path === '/signout')
    page = (
      <main id="main-content" className="content-width page center-page">
        <section className="panel gate">
          <h1>{t('signOut')}</h1>
          <button
            className="button button-primary"
            onClick={() =>
              void signOut()
                .catch(() => {})
                .finally(() => go('/'))
            }
          >
            {t('signOut')}
          </button>
        </section>
      </main>
    )
  else if (!logged)
    page = (
      <AccountGate
        destination={['/signin', '/register'].includes(path) ? '/lobby' : path}
        register={path === '/register'}
        invite={invite}
      />
    )
  else if (
    profileError === 'username_taken' ||
    profileError === 'profile_required' ||
    profileError === 'invalid_username'
  )
    page = <SetupProfile reload={() => setProfileVersion((n) => n + 1)} />
  else if (profileError && !me)
    page = (
      <main id="main-content" className="content-width page">
        <Notice error text={t(profileError)} />
        <div className="button-row">
          <button className="button button-outline" onClick={() => setProfileVersion((n) => n + 1)}>
            {t('retry')}
          </button>
          <a className="button button-outline" href="#/signout">
            {t('signOut')}
          </a>
        </div>
      </main>
    )
  else if (!me)
    page = (
      <main id="main-content" className="content-width page">
        <p role="status">{t('loading')}</p>
      </main>
    )
  else if (path === '/lobby' || path === '/signin' || path === '/register') page = <Lobby />
  else if (invite) {
    const direct = path.startsWith('/join/table/')
    const value = path.slice(direct ? '/join/table/'.length : '/join/'.length)
    page = <Invitation key={path} value={value} direct={direct} />
  } else if (path.startsWith('/table/'))
    page = <Game key={path} id={path.slice('/table/'.length)} />
  else if (path.startsWith('/account')) page = <Account path={path} />
  else if (path.startsWith('/admin'))
    page =
      me.role === 'player' ? (
        <main id="main-content" className="page content-width">
          <Notice error text={t('forbidden')} />
        </main>
      ) : (
        <Admin path={path} />
      )
  else
    page = (
      <main id="main-content" className="page content-width">
        <Notice error text={t('not_found')} />
        <a className="button button-outline" href="#/lobby">
          {t('back')}
        </a>
      </main>
    )
  return (
    <State.Provider value={{ t, locale, selectLocale, me, setMe, toast: setMessage }}>
      <Header authenticated={logged} path={path} />
      <Suspense
        fallback={
          <main id="main-content" className="content-width page">
            <p role="status">{t('loading')}</p>
          </main>
        }
      >
        {page}
      </Suspense>
      <Footer />
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </State.Provider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
