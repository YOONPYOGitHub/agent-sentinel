import { expect, test, type APIRequestContext } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function caseIdFrom(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  ) {
    throw new Error('Governance create response did not contain a case id.')
  }
  return value.id
}

async function createCase(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await request.post('/api/governance/queue', {
    data: {
      ...body,
      idempotencyKey: uniqueKey('create'),
    },
  })
  const payload: unknown = await response.json()
  expect(response.ok(), JSON.stringify(payload)).toBe(true)
  return caseIdFrom(payload)
}

async function transition(
  request: APIRequestContext,
  caseId: string,
  operation: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const response = await request.post(`/api/governance/queue/${caseId}/transitions`, {
    data: {
      operation,
      ...body,
      idempotencyKey: uniqueKey(operation),
    },
  })
  const payload: unknown = await response.json()
  expect(response.ok(), JSON.stringify(payload)).toBe(true)
}

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
  await expect(page.getByText(/disabled authorization · anonymous/i)).toBeVisible()
  await expect(page.getByText(/mock evidence · \d+ references/i).last()).toBeVisible()
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

test('audits approve, reject, expire, and re-evaluate lifecycle decisions', async ({
  page,
  request,
}) => {
  await page.goto('/work-queue')

  const approvalRow = page.getByRole('row', { name: /gq-003/i })
  await approvalRow.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(approvalRow.getByText('Approved', { exact: true })).toBeVisible()
  await approvalRow.getByRole('button', { name: 'Details' }).click()
  await expect(
    page.locator('.work-queue-detail-row').getByText('Approve', { exact: true }),
  ).toBeVisible()

  const rejectionId = await createCase(request, {
    kind: 'remediation-proposal',
    title: 'E2E rejection decision',
    description: 'Exercise the rejected governance decision and its audit record.',
    actorIdentity: 'E2E Analyst',
    actorRole: 'Analyst',
    evidenceSnapshotIds: ['e2e-rejection-evidence'],
  })
  await transition(request, rejectionId, 'pick-up', {
    actorIdentity: 'E2E Analyst',
    actorRole: 'Analyst',
  })
  await transition(request, rejectionId, 'propose', {
    actorIdentity: 'E2E Analyst',
    actorRole: 'Analyst',
  })

  const search = page.getByRole('textbox', { name: 'Search governance cases' })
  await search.fill(rejectionId)
  const rejectionRow = page.getByRole('row', { name: new RegExp(rejectionId) })
  await rejectionRow.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(rejectionRow.getByText('Rejected', { exact: true })).toBeVisible()
  await rejectionRow.getByRole('button', { name: 'Details' }).click()
  await expect(
    page.locator('.work-queue-detail-row').getByText('Reject', { exact: true }),
  ).toBeVisible()

  const expiresAt = new Date(Date.now() + 3_000).toISOString()
  const exceptionId = await createCase(request, {
    kind: 'policy-exception',
    title: 'E2E expiring policy exception',
    description: 'Exercise expiry and evidence-backed re-evaluation.',
    actorIdentity: 'E2E Analyst',
    actorRole: 'Analyst',
    policyId: 'AS-POL-E2E',
    expiresAt,
    evidenceSnapshotIds: ['e2e-exception-original'],
  })
  await transition(request, exceptionId, 'pick-up', {
    actorIdentity: 'E2E Analyst',
    actorRole: 'Analyst',
  })
  await page.waitForTimeout(Math.max(0, Date.parse(expiresAt) - Date.now()) + 250)
  await search.fill(exceptionId)

  const exceptionRow = page.getByRole('row', { name: new RegExp(exceptionId) })
  await exceptionRow.getByRole('button', { name: 'Expire', exact: true }).click()
  await expect(exceptionRow.getByText('Expired', { exact: true })).toBeVisible()

  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 16)
  await page
    .getByRole('textbox', { name: `New exception expiry for ${exceptionId}` })
    .fill(futureExpiry)
  await page
    .getByRole('textbox', { name: `New evidence snapshot for ${exceptionId}` })
    .fill('e2e-exception-refreshed')
  await exceptionRow.getByRole('button', { name: 'Re-evaluate', exact: true }).click()
  await expect(exceptionRow.getByText('Open', { exact: true })).toBeVisible()
  await exceptionRow.getByRole('button', { name: 'Details' }).click()

  const exceptionDetail = page.locator('.work-queue-detail-row')
  await expect(exceptionDetail.getByText('Expire', { exact: true })).toBeVisible()
  await expect(exceptionDetail.getByText('Re-evaluate', { exact: true })).toBeVisible()
  const reEvaluation = exceptionDetail.locator('.work-queue-timeline li').filter({
    hasText: 'Re-evaluate',
  })
  await expect(reEvaluation.getByText('mock evidence · 4 references')).toBeVisible()
})
