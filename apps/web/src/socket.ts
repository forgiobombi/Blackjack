import { useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  Command,
  PlayerCommand,
  SocketMessage,
  View,
} from '../../../packages/protocol/types.ts'
import { api, ApiError, codeOf, socketUrl } from './api.ts'

type Pending = {
  command: Command
  resolve: () => void
  reject: (error: ApiError) => void
  timer: number
}

export function useTableSocket(id: string, profileId: string) {
  const [view, setView] = useState<View>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connection, setConnection] = useState<'connecting' | 'online' | 'reconnecting' | 'closed'>(
    'connecting',
  )
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const socket = useRef<WebSocket | undefined>(undefined)
  const pending = useRef(new Map<string, Pending>())
  const synced = useRef(false)

  useEffect(() => {
    let stopped = false
    let connectionAttempt = 0
    let timer: number | undefined
    let connecting = false
    let sequence = -1
    let handshakeTimer: number | undefined
    synced.current = false
    function retryLater() {
      if (stopped || timer !== undefined) return
      setConnection('reconnecting')
      const delay =
        Math.min(24_000, 450 * 2 ** Math.min(connectionAttempt++, 6)) + Math.random() * 220
      timer = window.setTimeout(() => {
        timer = undefined
        void connect()
      }, delay)
    }
    function sendSnapshot(ws: WebSocket) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ kind: 'snapshot', tableId: id, id: crypto.randomUUID() }))
    }
    async function connect() {
      if (stopped || connecting || socket.current?.readyState === WebSocket.OPEN) return
      connecting = true
      try {
        const { ticket } = await api<{ ticket: string }>('/tables/' + id + '/ticket', {
          method: 'POST',
        })
        if (stopped) return
        const ws = new WebSocket(socketUrl(id), ['royale.v1', 'ticket.' + ticket])
        socket.current = ws
        handshakeTimer = window.setTimeout(() => ws.close(), 10_000)
        ws.onmessage = (event) => {
          if (stopped || socket.current !== ws) return
          let incoming: SocketMessage
          try {
            incoming = JSON.parse(event.data)
          } catch {
            return
          }
          if (incoming.type === 'reply') {
            const command = pending.current.get(incoming.id)
            if (command) {
              pending.current.delete(incoming.id)
              window.clearTimeout(command.timer)
              if (incoming.ok) command.resolve()
              else {
                if (incoming.error === 'stale') sendSnapshot(ws)
                command.reject(new ApiError(incoming.error ?? 'unavailable'))
              }
            }
            return
          }
          if (incoming.type !== 'state' || incoming.tableId !== id) return
          if (!synced.current && incoming.kind !== 'snapshot') return
          if (incoming.sequence < sequence && incoming.kind !== 'snapshot') return
          if (incoming.sequence > sequence + 1 && sequence >= 0 && incoming.kind !== 'snapshot') {
            sendSnapshot(ws)
            return
          }
          sequence = incoming.sequence
          setView(incoming)
          if (incoming.messages) {
            if (incoming.kind === 'snapshot') setMessages(incoming.messages)
            else
              setMessages((current) =>
                [
                  ...current,
                  ...incoming.messages!.filter(
                    (item) =>
                      !current.some(
                        (prior) => prior.id === item.id && prior.author === item.author,
                      ),
                  ),
                ].slice(-60),
              )
          }
          if (!synced.current && incoming.kind === 'snapshot') {
            synced.current = true
            connectionAttempt = 0
            window.clearTimeout(handshakeTimer)
            setConnection('online')
            setError('')
            for (const { command } of pending.current.values()) ws.send(JSON.stringify(command))
          }
          if (incoming.phase === 'closed') setConnection('closed')
        }
        ws.onclose = (event) => {
          if (stopped || socket.current !== ws) return
          window.clearTimeout(handshakeTimer)
          socket.current = undefined
          synced.current = false
          if (event.code === 4004 || event.code === 4003) {
            setError(event.reason || 'closed')
            setConnection('closed')
          } else retryLater()
        }
      } catch (e) {
        if (stopped) return
        const code = codeOf(e)
        if (
          [
            'closed',
            'suspended',
            'membership',
            'not_found',
            'banned',
            'session_expired',
            'auth_required',
            'configuration',
          ].includes(code)
        ) {
          setConnection('closed')
          setError(code)
        } else {
          setError(code)
          retryLater()
        }
      } finally {
        connecting = false
      }
    }
    function foreground() {
      if (document.hidden) return
      const ws = socket.current
      if (ws?.readyState === WebSocket.OPEN) sendSnapshot(ws)
      else if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
        void connect()
      }
    }
    void connect()
    window.addEventListener('online', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      stopped = true
      synced.current = false
      window.clearTimeout(timer)
      window.clearTimeout(handshakeTimer)
      socket.current?.close(1000)
      socket.current = undefined
      document.removeEventListener('visibilitychange', foreground)
      window.removeEventListener('online', foreground)
      for (const wait of pending.current.values()) {
        window.clearTimeout(wait.timer)
        wait.reject(new ApiError('unavailable'))
      }
      pending.current.clear()
    }
  }, [id, profileId, retry])

  function send(payload: PlayerCommand): Promise<void> {
    const ws = socket.current
    if (!synced.current || ws?.readyState !== WebSocket.OPEN)
      return Promise.reject(new ApiError('reconnecting'))
    const command: Command = { ...payload, id: crypto.randomUUID(), tableId: id }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.current.delete(command.id)
        reject(new ApiError('reconnecting'))
      }, 12_000)
      pending.current.set(command.id, { command, resolve, reject, timer })
      try {
        ws.send(JSON.stringify(command))
      } catch {
        pending.current.delete(command.id)
        window.clearTimeout(timer)
        reject(new ApiError('reconnecting'))
      }
    })
  }

  return {
    view,
    messages,
    connection,
    error,
    send,
    reconnect: () => {
      setConnection('connecting')
      setError('')
      setRetry((n) => n + 1)
    },
  }
}
