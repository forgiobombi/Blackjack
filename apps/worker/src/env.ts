import type { Avatar, Role } from '../../../packages/protocol/types.ts'

type Limiter = { limit(input: { key: string }): Promise<{ success: boolean }> }
export type Env = {
  APP_URL: string
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  AUTH_BRIDGE_KEY: string
  DB: D1Database
  TABLES: DurableObjectNamespace
  API_LIMIT: Limiter
  AUTH_LIMIT: Limiter
  JOIN_LIMIT: Limiter
}
export type Identity = {
  id: string
  session: string
  expiry: number
  metadata: Record<string, unknown>
}
export type Principal = Omit<Identity, 'metadata'> & {
  role: Role
  name: string
  avatar: Avatar
  balance: number
}
