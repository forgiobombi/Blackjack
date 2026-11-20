import { test, expect, devices } from '@playwright/test'
import type { Page } from '@playwright/test'

const BASE = 'http://localhost:5173/Blackjack/'
const password = 'correct-horse-battery-123'
const testCode = '536781'

async function signIn(page: Page) {
  await page.goto(BASE + '#/signin')
  await page.getByRole('main').getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByLabel('Email address').fill('host@example.test')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'The lounge' })).toBeVisible()
}

test('Two browsers play from an invitation and recover a mobile seat', async ({
  page,
  browser,
}, info) => {
  const jsErrors: string[] = []
  page.on('pageerror', (error) => jsErrors.push(error.message))
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'Blackjack Royale.' })).toBeVisible()
  await expect(page.locator('.hero-photo')).toHaveJSProperty('complete', true)
  await page.screenshot({
    path: info.outputPath('landing-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await signIn(page)
  await page.getByRole('link', { name: 'Create table', exact: true }).click()
  await page.getByLabel('Table name', { exact: true }).fill('The Emerald Room')
  await page.getByLabel('Betting window (seconds)').fill('14')
  await page.getByLabel('Turn duration (seconds)').fill('45')
  await page.getByRole('checkbox', { name: 'Insurance', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Create table', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'The Emerald Room' })).toBeVisible()
  await page.getByRole('button', { name: 'Take seat 1', exact: true }).click()
  await page.getByRole('button', { name: 'Invite friends' }).click()
  await page.getByRole('button', { name: 'Create invitation' }).click()
  const linkField = page.getByRole('textbox', { name: 'Share link' })
  await expect(linkField).toHaveValue(/Blackjack\/#\/join\/[A-Za-z0-9_-]{32}$/)
  const url = await linkField.inputValue()
  const code = await page.getByRole('textbox', { name: 'Short code' }).inputValue()
  await expect(page.getByAltText('Invitation QR code')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()

  const mobile = await browser.newContext({ ...devices['Pixel 7'], locale: 'it-IT' })
  const friend = await mobile.newPage()
  friend.on('pageerror', (error) => jsErrors.push(error.message))
  try {
    await friend.goto(url)
    await expect(friend.getByRole('heading', { name: 'Sei invitato' })).toBeVisible()
    await friend
      .getByRole('main')
      .getByRole('button', { name: 'Crea account', exact: true })
      .click()
    await friend.getByLabel('Nome utente').fill('guest_italy')
    await friend.getByLabel('Indirizzo email').fill('guest_italy@example.test')
    await friend.getByLabel('Password', { exact: true }).fill(password)
    await friend.getByLabel('Conferma password').fill(password)
    await friend.getByRole('button', { name: 'Continua' }).click()
    await expect(friend.getByRole('heading', { name: 'Verifica la tua email' })).toBeVisible()
    await friend.getByLabel('Codice ricevuto via email').fill(testCode)
    await friend.getByRole('button', { name: 'Continua' }).click()
    await friend.getByRole('button', { name: 'Entra al tavolo' }).click()
    await expect(friend.locator('.casino-board')).toBeVisible()
    await friend.screenshot({ path: info.outputPath('table-mobile.png'), fullPage: true })
    await expect
      .poll(() => friend.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(1)
    await friend.getByRole('button', { name: 'Prendi il posto 2', exact: true }).click()

    await page.getByRole('button', { name: 'Open betting' }).click()
    await page.getByRole('spinbutton', { name: 'Bet amount' }).fill('25')
    await page.getByRole('button', { name: 'Confirm bet' }).click()
    await friend.getByRole('spinbutton', { name: 'Importo della puntata' }).fill('10')
    await friend.getByRole('button', { name: 'Conferma puntata' }).click()
    await expect(friend.getByText('Puntata confermata')).toBeVisible()
    await expect(friend.locator('.my-hands .playing-card')).toHaveCount(2, { timeout: 17_000 })
    await page.screenshot({ path: info.outputPath('table-desktop.png'), fullPage: true })

    const cards = await friend.locator('.my-hands .playing-card').allTextContents()
    await friend.reload()
    await expect(friend.locator('.my-hands .playing-card')).toHaveCount(2)
    await expect(friend.locator('.my-hands .playing-card')).toHaveText(cards)
    const standButtons = [
      page.getByRole('button', { name: 'Stand', exact: true }),
      friend.getByRole('button', { name: 'Stai', exact: true }),
    ]
    await expect
      .poll(
        async () => {
          for (const stand of standButtons) {
            if ((await stand.isVisible()) && (await stand.isEnabled())) await stand.click()
          }
          return page.getByText('Round complete', { exact: true }).isVisible()
        },
        { timeout: 12_000 },
      )
      .toBe(true)
    await expect(page.getByText('Round complete', { exact: true })).toBeVisible()
    await expect(friend.getByText('Mano conclusa', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Next round', exact: true }).click()
    await expect(page.getByText('Bets are open', { exact: true })).toBeVisible()
    await friend.goto(BASE + '#/lobby')
    await friend.getByRole('textbox', { name: 'Codice invito' }).fill(code)
    await friend.getByRole('button', { name: 'Trova il tavolo' }).click()
    await expect(friend.getByRole('heading', { name: 'The Emerald Room' })).toBeVisible()
    await friend.getByRole('button', { name: 'Entra al tavolo' }).click()
    await page.getByRole('button', { name: 'Close table', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close table', exact: true }).click()
    await expect(page.getByText('This table is closed.').first()).toBeVisible()
    await page.goto(BASE + '#/account/history')
    await expect(page.getByRole('link', { name: 'Replay' })).toBeVisible()
    await page.getByRole('link', { name: 'Replay' }).click()
    await page.getByRole('button', { name: 'Next event' }).click()
    await expect(page.getByText(/Event 2 of/)).toBeVisible()
    expect(jsErrors).toEqual([])
  } finally {
    await mobile.close()
  }
})

test('Password recovery and subsequent login work on the authentication origin', async ({
  page,
}) => {
  await page.goto(BASE + '#/register')
  await page.getByRole('main').getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Username').fill('recovery_guest')
  await page.getByLabel('Email address').fill('recovery_guest@example.test')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Email verification code').fill(testCode)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'The lounge' })).toBeVisible()
  await page.goto(BASE + '#/signout')
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Blackjack Royale.' })).toBeVisible()
  await page.goto(BASE + '#/signin')
  await page.getByRole('main').getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await page.getByLabel('Email address').fill('recovery_guest@example.test')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
  const newPassword = password + '-changed'
  await page.getByLabel('Email verification code').fill(testCode)
  await page.getByLabel('Password', { exact: true }).fill(newPassword)
  await page.getByLabel('Confirm password').fill(newPassword)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'The lounge' })).toBeVisible()
  await page.goto(BASE + '#/signout')
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Blackjack Royale.' })).toBeVisible()
  await page.goto(BASE + '#/signin')
  await page.getByRole('main').getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByLabel('Email address').fill('recovery_guest@example.test')
  await page.getByLabel('Password', { exact: true }).fill(newPassword)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'The lounge' })).toBeVisible()
})
