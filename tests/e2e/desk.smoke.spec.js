import { test, expect, devices } from '@playwright/test'

test('first run completes an order-to-exit lifecycle with a backfilled update', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    const RealDate = Date
    const fixedTime = RealDate.parse('2026-08-06T05:45:00.000Z')
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedTime] : args))
      }
      static now() { return fixedTime }
    }
    window.Date = FixedDate
  })
  await page.goto('')
  await expect(page.getByRole('heading', { name: 'Trend is the only edge.' })).toBeVisible()
  await page.getByRole('button', { name: /Enter the desk/i }).click()

  await page.getByRole('button', { name: 'Load sample' }).click()
  await page.getByRole('textbox', { name: 'Ticker' }).fill('NABIL')
  await page.getByRole('textbox', { name: 'Planned entry' }).fill('100')
  await page.getByRole('textbox', { name: 'ATR (14)' }).fill('1')
  await expect(page.getByText('Shares')).toBeVisible()
  await expect(page.getByRole('button', { name: /Place pending order/i })).toBeEnabled()
  await page.getByRole('button', { name: /Place pending order/i }).click()
  await expect(page.getByText('NABIL pending order logged.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pending orders' })).toBeVisible()

  await page.getByRole('button', { name: 'Log session' }).click()
  await expect(page.getByText('NABIL session and fill recorded.')).toBeVisible()
  await expect(page.getByText('No pending orders.')).toBeVisible()

  await page.getByLabel('NABIL update date').fill('2026-08-08')
  await page.getByRole('textbox', { name: 'NABIL close' }).fill('110')
  await page.getByRole('textbox', { name: 'NABIL ATR' }).fill('2')
  await page.getByRole('button', { name: 'Daily update' }).click()
  await page.getByLabel('NABIL update date').fill('2026-08-07')
  await page.getByRole('textbox', { name: 'NABIL close' }).fill('105')
  await page.getByRole('button', { name: 'Daily update' }).click()

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('atr-desk:state:v2')))
  expect(stored.state.activeTrades[0].updateLog.map(({ dateISO }) => dateISO)).toEqual([
    '2026-08-06',
    '2026-08-07',
    '2026-08-08',
  ])

  await page.getByLabel('NABIL sale date').fill('2026-08-10')
  await page.getByRole('textbox', { name: 'NABIL sell shares' }).fill('4000')
  await page.getByRole('textbox', { name: 'NABIL exit price' }).fill('110')
  await page.getByRole('textbox', { name: 'NABIL exit reason' }).fill('Target reached')
  await page.getByRole('button', { name: 'Log sale' }).click()
  await expect(page.getByText('No open positions.')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'NABIL' })).toBeVisible()
})

test('mobile shell remains usable after an offline reload', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Workbox offline navigation is verified in Chromium projects.')
  const context = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('atr-desk:intro-complete', '1'))
  await page.goto('')
  await expect(page.getByRole('heading', { name: 'Earn your slot.' })).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Earn your slot.' })).toBeVisible()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Earn your slot.' })).toBeVisible()
  await context.close()
})
