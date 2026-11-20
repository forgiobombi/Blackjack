import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { REACTIONS } from '../../../packages/protocol/types.ts'
import type { ChatMessage, PlayerCommand } from '../../../packages/protocol/types.ts'
import { api, codeOf } from './api.ts'
import { useApp } from './state.tsx'
import { AvatarIcon, Empty, Icon, Modal, Notice } from './ui.tsx'

export function TableChat({
  id,
  messages,
  canSend,
  send,
  close,
}: {
  id: string
  messages: ChatMessage[]
  canSend: boolean
  send: (command: PlayerCommand) => Promise<void>
  close: () => void
}) {
  const { t, me, locale, toast } = useApp()
  const [text, setText] = useState('')
  const [muted, setMuted] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('royale.chat.muted') ?? '[]')
    } catch {
      return []
    }
  })
  const [report, setReport] = useState<ChatMessage>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const visible = messages.filter((item) => !muted.includes(item.author))
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages.length])
  function mute(user: string) {
    const next = muted.includes(user)
      ? muted.filter((id) => id !== user)
      : [...muted, user].slice(-100)
    setMuted(next)
    localStorage.setItem('royale.chat.muted', JSON.stringify(next))
  }
  async function sendText(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      await send({ kind: 'chat', text })
      setText('')
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = new FormData(event.currentTarget).get('reason')
    setError('')
    try {
      await api('/tables/' + id + '/report', { body: { id: report!.id, reason } })
      setReport(undefined)
      toast(t('reportSent'))
    } catch (e) {
      setError(codeOf(e))
    }
  }
  return (
    <aside className="chat-panel panel" aria-label={t('chat')}>
      <div className="section-head">
        <h2>
          <Icon name="chat" size={19} />
          {t('chat')}
        </h2>
        <button className="icon-button" onClick={close} aria-label={t('close')}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="chat-log" role="log" ref={log} aria-label={t('chat')}>
        {!visible.length && <Empty>{t('noMessages')}</Empty>}
        {visible.map((item) => (
          <article className="chat-message" key={item.author + item.id}>
            <AvatarIcon avatar={item.avatar} />
            <div>
              <div className="chat-byline">
                <b>{item.name}</b>
                <time dateTime={new Date(item.at).toISOString()}>
                  {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
                    item.at,
                  )}
                </time>
              </div>
              <p>{item.text}</p>
              {me?.id !== item.author && (
                <div className="chat-moderation">
                  <button onClick={() => mute(item.author)}>{t('mute')}</button>
                  <button
                    onClick={() => {
                      setReport(item)
                      setError('')
                    }}
                  >
                    {t('report')}
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
      {muted.some((user) => messages.some((item) => item.author === user)) && (
        <div className="chat-moderation">
          {muted.map((user) => {
            const author = messages.find((item) => item.author === user)
            return (
              author && (
                <button key={user} onClick={() => mute(user)}>
                  {t('unmute')} {author.name}
                </button>
              )
            )
          })}
        </div>
      )}
      {!report && error && <Notice error text={t(error)} />}
      {canSend && (
        <>
          <div className="quick-reactions" aria-label={t('reactions')}>
            {REACTIONS.map((reaction) => (
              <button
                type="button"
                key={reaction}
                onClick={() =>
                  void send({ kind: 'reaction', value: reaction }).catch((e) => setError(codeOf(e)))
                }
              >
                {t(reaction)}
              </button>
            ))}
          </div>
          <form className="chat-form" onSubmit={(e) => void sendText(e)}>
            <input
              placeholder={t('message')}
              aria-label={t('message')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={280}
              required
            />
            <button className="icon-button" aria-label={t('send')} disabled={busy || !text.trim()}>
              <Icon name="arrow" size={18} />
            </button>
          </form>
        </>
      )}
      {report && (
        <Modal close={() => setReport(undefined)} t={t} title={t('report')}>
          <p className="muted">{report.text}</p>
          {error && <Notice error text={t(error)} />}
          <form className="stack" onSubmit={(e) => void submitReport(e)}>
            <label className="field">
              {t('reportReason')}
              <input name="reason" minLength={3} maxLength={160} required />
            </label>
            <button className="button button-primary">{t('report')}</button>
          </form>
        </Modal>
      )}
    </aside>
  )
}
