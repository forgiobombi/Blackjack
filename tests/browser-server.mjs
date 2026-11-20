import { build, preview } from 'vite'
import { fixture } from './runtime.mjs'

const backend = await fixture({ port: 8787 })
await backend.newPlayer('host', 'superadmin')
process.env.VITE_API_URL = backend.base
process.env.VITE_BASE = '/Blackjack/'
const configFile = 'apps/web/vite.config.ts'
await build({ configFile })
const server = await preview({
  configFile,
  preview: { host: 'localhost', port: 5173, strictPort: true },
})
console.log('Browser fixture ready at http://localhost:5173/Blackjack/')

async function stop() {
  await server.close()
  await backend.close()
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
