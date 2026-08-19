import { expect, test } from '@playwright/test'

test('governance posture links policy controls to filtered findings', async ({ page }) => {
  await page.goto('/governance')
  await expect(page.getByRole('heading', { name: 'Policy governance' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Active controls' })).toBeVisible()
  await expect(page.getByText('Declared-configuration evidence')).toBeVisible()

  const policyRow = page.getByRole('row', { name: /AS-POL-001/i })
  await expect(policyRow.getByText('Needs attention')).toBeVisible()
  await policyRow.getByRole('link', { name: 'View findings' }).click()

  await expect(page).toHaveURL(/\/exposure\?policyId=AS-POL-001$/)
  await expect(page.getByRole('combobox', { name: 'Policy' })).toHaveValue('AS-POL-001')
  await expect(page.locator('.exposure-table tbody tr')).toHaveCount(2)
})
