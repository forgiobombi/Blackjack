import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const envDir = fileURLToPath(new URL('../..', import.meta.url))
export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, envDir, 'VITE_'), ...process.env }
  const api = env.VITE_API_URL ? new URL(env.VITE_API_URL) : undefined
  if (api && !['https:', 'http:'].includes(api.protocol))
    throw new Error('VITE_API_URL must use HTTPS or local HTTP')
  if (api?.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(api.hostname))
    throw new Error('VITE_API_URL must use HTTPS outside local development')
  const connection = api ? ' ' + api.origin + ' ' + api.origin.replace(/^http/, 'ws') : ''
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir,
    base: env.VITE_BASE || '/',
    plugins: [
      react(),
      {
        name: 'royale-content-security',
        transformIndexHtml:
          command === 'build'
            ? {
                order: 'pre',
                handler: (html) =>
                  html.replace(
                    '<meta name="referrer" content="no-referrer" />',
                    "<meta name=\"referrer\" content=\"no-referrer\" /><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'" +
                      connection +
                      "; base-uri 'none'; object-src 'none'; form-action 'none'\" />",
                  ),
              }
            : undefined,
      },
    ],
    server: { host: 'localhost', port: 5173, strictPort: true },
  }
})
