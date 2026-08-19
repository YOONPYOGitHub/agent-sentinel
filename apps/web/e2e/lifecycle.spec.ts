import { expect, test } from '@playwright/test'

test('lifecycle reports current evidence and links to agent detail', async ({ page }) => {
  await page.goto('/lifecycle')
  await expect(page.getByRole('heading', { name: 'Lifecycle evidence' })).toBeVisible()
  await expect(
    page.getByText('Current-version evidence, not full release orchestration'),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Agent readiness evidence' })).toBeVisible()

  await page
    .getByRole('combobox', { name: 'Filter lifecycle by environment' })
    .selectOption('production')
  const row = page.getByRole('row', { name: /HR Policy Assistant/i })
  await expect(row).toContainText('12')
  await expect(row).toContainText('Published')
  await row.getByRole('link', { name: 'View agent' }).click()
  await expect(page.getByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
})
