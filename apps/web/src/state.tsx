import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Locale, Profile } from '../../../packages/protocol/types.ts'
import { api, codeOf } from './api.ts'
import type { T } from './i18n.ts'

export type AppState = {
  t: T
  locale: Locale
  selectLocale: (locale: Locale) => void
  me: Profile | null
  setMe: (profile: Profile) => void
  toast: (text: string) => void
}
export const State = createContext<AppState | null>(null)

export function useApp() {
  return useContext(State)!
}

export function route() {
  return location.hash.startsWith('#/') ? location.hash.slice(1).split('?')[0] : '/'
}

export function go(path: string, replace = false) {
  const hash = '#' + path
  if (location.hash === hash) return
  if (replace) {
    history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else location.hash = hash
}

export function useResource<T>(path: string | null) {
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>()
  useEffect(() => {
    if (!path) return
    let ignore = false
    api<T>(path).then(
      (data) => {
        if (!ignore) setState({ path, data })
      },
      (error) => {
        if (!ignore) setState({ path, error: codeOf(error) })
      },
    )
    return () => {
      ignore = true
    }
  }, [path, version])
  const reload = useCallback(() => setVersion((n) => n + 1), [])
  const same = state?.path === path ? state : undefined
  return { data: same?.data, error: same?.error, loading: Boolean(path && !same), reload }
}
