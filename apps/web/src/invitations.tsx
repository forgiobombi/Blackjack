import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, codeOf, inviteLink } from './api.ts'
import { dateTime } from './i18n.ts'
import { useApp, useResource } from './state.tsx'
import { Empty, Icon, Modal, Notice } from './ui.tsx'

type Invitation = { id: string; maxUses: number; uses: number; expiresAt: number; revoked: number }
type Created = { id: string; token: string; code: string; expiresAt: number }
type Friend = { id: string; name: string; status: string }

export default function Invitations({
  id,
  close,
  owner,
}: {
  id: string
  close: () => void
  owner: boolean
}) {
  const { t, locale, toast } = useApp()
  const resource = useResource<{ invitations: Invitation[] }>(
    owner ? '/tables/' + id + '/invitations' : null,
  )
  const friends = useResource<{ friends: Friend[] }>('/friends')
  const [created, setCreated] = useState<Created>()
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recipient, setRecipient] = useState('')
  const link = created ? inviteLink(created.token) : ''
  useEffect(() => {
    if (!link) return
    let active = true
    import('qrcode')
      .then(({ default: QR }) =>
        QR.toDataURL(link, {
          width: 170,
          margin: 2,
          color: { dark: '#14231aff', light: '#f3e8cdff' },
        }),
      )
      .then(
        (data) => {
          if (active) setQr(data)
        },
        () => {},
      )
    return () => {
      active = false
    }
  }, [link])
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    setQr('')
    try {
      setCreated(
        await api<Created>('/tables/' + id + '/invite', {
          body: {
            recipient: recipient || undefined,
            minutes: Number(form.get('minutes') ?? 120),
            uses: Number(form.get('uses') ?? 1),
          },
        }),
      )
      resource.reload()
    } catch (e) {
      setError(codeOf(e))
    } finally {
      setBusy(false)
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast(t('copied'))
    } catch {
      setError('browserUnsupported')
    }
  }
  async function revoke(invite: string) {
    try {
      await api('/tables/' + id + '/invitations/' + invite, { method: 'POST' })
      if (created?.id === invite) setCreated(undefined)
      resource.reload()
    } catch (e) {
      setError(codeOf(e))
    }
  }
  return (
    <Modal close={close} t={t} title={t('inviteFriends')}>
      {error && <Notice error text={t(error)} />}
      <form onSubmit={(e) => void create(e)} className="form-grid">
        <label className="field">
          {t('inviteFriend')}
          <select
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required={!owner}
          >
            <option value="">{owner ? t('optional') : '—'}</option>
            {friends.data?.friends
              .filter((friend) => friend.status === 'friends')
              .map((friend) => (
                <option key={friend.id} value={friend.id}>
                  {friend.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('expiryMinutes')}
          <input type="number" name="minutes" defaultValue="120" min="5" max="1440" required />
        </label>
        {owner && !recipient && (
          <label className="field">
            {t('allowedUses')}
            <input type="number" name="uses" defaultValue="10" min="1" max="32" required />
          </label>
        )}
        {recipient && <p className="muted">{t('inviteScope')}</p>}
        <div className="form-wide">
          <button className="button button-primary" disabled={busy}>
            {t('inviteMake')}
          </button>
        </div>
      </form>
      {created && (
        <div className="invite-output">
          <div>
            <label className="field">
              {t('inviteLink')}
              <span className="copy-row">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button
                  className="icon-button"
                  onClick={() => void copy(link)}
                  aria-label={t('copy') + ' ' + t('inviteLink')}
                >
                  <Icon name="copy" />
                </button>
              </span>
            </label>
            <label className="field">
              {t('shortCode')}
              <span className="copy-row">
                <input readOnly value={created.code} onFocus={(e) => e.target.select()} />
                <button
                  className="icon-button"
                  onClick={() => void copy(created.code)}
                  aria-label={t('copy') + ' ' + t('shortCode')}
                >
                  <Icon name="copy" />
                </button>
              </span>
            </label>
            <small className="muted">
              {t('expires', { date: dateTime(created.expiresAt, locale) })}
            </small>
          </div>
          {qr && <img src={qr} alt={t('qr')} width="140" height="140" />}
        </div>
      )}
      {owner && (
        <section className="stack">
          <h3>{t('invites')}</h3>
          {resource.error && <Notice error text={t(resource.error)} />}
          {resource.data?.invitations.length === 0 && <Empty>{t('noInvites')}</Empty>}
          {resource.data?.invitations.map((item) => (
            <div className="list-item" key={item.id}>
              <div>
                <b>
                  {t(
                    item.revoked
                      ? 'revoked'
                      : item.expiresAt <= Date.now()
                        ? 'invite_expired'
                        : 'uses',
                    { used: item.uses, max: item.maxUses },
                  )}
                </b>
                <small>{t('expires', { date: dateTime(item.expiresAt, locale) })}</small>
              </div>
              {!item.revoked && (
                <button className="button button-outline" onClick={() => void revoke(item.id)}>
                  {t('revoke')}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </Modal>
  )
}
