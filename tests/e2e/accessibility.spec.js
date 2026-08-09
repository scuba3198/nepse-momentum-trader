import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function expectNoSeriousViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const serious = results.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')
  expect(serious, serious.map(({ id, help }) => `${id}: ${help}`).join('\n')).toEqual([])
}

test('intro and operating desk pass automated accessibility checks', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('')
  await expect(page.getByRole('heading', { name: 'Trend is the only edge.' })).toBeVisible()
  await expectNoSeriousViolations(page)

  await page.getByRole('button', { name: /Enter the desk/i }).click()
  await expect(page.getByRole('heading', { name: 'Earn your slot.' })).toBeVisible()
  await expectNoSeriousViolations(page)
})
