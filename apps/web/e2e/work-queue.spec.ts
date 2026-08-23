import { expect, test } from '@playwright/test'

test('governance work queue renders evidence-backed workflow state and filters', async ({
  page,
}) => {
  await page.goto('/work-queue')

  await expect(page.getByRole('heading', { name: 'Governance work queue' })).toBeVisible()
  await expect(page.getByText('[Mock] Deterministic queue data')).toBeVisible()
  await expect(page.getByText(/Separation of duties:/i)).toBeVisible()
  await expect(page.getByText('5 cases')).toBeVisible()

  await page.getByRole('combobox', { name: 'Status' }).selectOption('approved')
  await expect(
    page.getByText('[Mock] Close documented exception after control update'),
  ).toBeVisible()
  await expect(
    page.locator('.work-queue-table tbody > tr:not(.work-queue-detail-row)'),
  ).toHaveCount(1)
})

test('governance work queue applies and audits a deterministic transition', async ({ page }) => {
  await page.goto('/work-queue')

  const caseRow = page.getByRole('row', { name: /gq-001/i })
  await expect(caseRow.getByText('Open', { exact: true })).toBeVisible()
  await caseRow.getByRole('button', { name: 'Pick up' }).click()
  await expect(caseRow.getByText('In review', { exact: true })).toBeVisible()

  await caseRow.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByText('Created', { exact: true })).toBeVisible()
  await expect(page.getByText('Pick up', { exact: true })).toBeVisible()
  await expect(page.getByText(/None\s*→\s*Open/)).toBeVisible()
  await expect(page.getByText(/Open\s*→\s*In review/)).toBeVisible()
})

test('exposure finding deep link prefills a governance remediation case', async ({ page }) => {
  await page.goto('/exposure')
  const findingLink = page.locator('.exposure-table tbody tr').first().locator('a').first()
  await findingLink.click()
  await page.getByRole('button', { name: 'Create governance case' }).click()

  await expect(page).toHaveURL(/\/work-queue$/)
  await expect(page.getByRole('region', { name: 'Create governance case' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Finding ID' })).not.toHaveValue('')
  await expect(page.getByRole('textbox', { name: 'Agent ID' })).not.toHaveValue('')
  await expect(page.getByRole('textbox', { name: 'Policy ID' })).not.toHaveValue('')
  await expect(page.getByRole('textbox', { name: 'Evidence snapshot ID' })).not.toHaveValue('')
})
