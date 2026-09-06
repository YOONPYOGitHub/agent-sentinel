import { expect, test } from '@playwright/test'

test('exposure navigation and detail deep link', async ({ page }) => {
  await page.goto('/exposure')
  await expect(page.getByRole('heading', { name: 'Exposure findings' })).toBeVisible()
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link') })
    .first()
  await expect(row).toBeVisible()
  const titleLink = row.locator('a').first()
  const findingHref = await titleLink.getAttribute('href')
  expect(findingHref).toMatch(/^\/exposure\//)
  await titleLink.click()
  await expect(page.getByText('Recommendation')).toBeVisible()

  // Deep link
  await page.goto(findingHref!)
  await expect(page.getByText('Recommendation')).toBeVisible()
  await expect(page.getByText('Declared configuration only.')).toBeVisible()

  await page.getByRole('button', { name: 'Preview response' }).click()
  await expect(page.getByText('Simulation only')).toBeVisible()
  await expect(page.getByRole('button', { name: 'After simulation' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('heading', { name: 'Residual findings' })).toBeVisible()

  await page.getByRole('button', { name: 'Generate AI narrative' }).click()
  await expect(
    page.getByRole('heading', { name: 'Evidence-grounded incident narrative' }),
  ).toBeVisible()
  await expect(page.getByText('deterministic-advisory-mock')).toBeVisible()
  await expect(
    page.getByText(/Deterministic policies and graph calculations remain authoritative/i),
  ).toBeVisible()
})
