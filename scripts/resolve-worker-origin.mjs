import { appendFileSync, readFileSync } from 'node:fs'

const configuredOrigin = process.env.VITE_API_URL?.trim()
if (!configuredOrigin) process.exit(0)

const origin = new URL(configuredOrigin)
if (
  origin.protocol !== 'https:' ||
  origin.pathname !== '/' ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash
)
  throw new Error('VITE_API_URL must be the HTTPS origin of the Blackjack Worker')

const labels = origin.hostname.split('.')
if (labels.length === 4 && labels.slice(2).join('.') === 'workers.dev') {
  const config = new URL('../apps/worker/wrangler.jsonc', import.meta.url)
  const { name } = JSON.parse(readFileSync(config, 'utf8'))
  origin.hostname = [name, ...labels.slice(1)].join('.')
}

appendFileSync(process.env.GITHUB_OUTPUT, 'origin=' + origin.origin + '\n')
