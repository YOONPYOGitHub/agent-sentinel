import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test('contains a validated attack path and preserves the business workflow', async ({ page }) => {
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByText('Theoretical exposure')).toBeVisible()
  await page.getByRole('button', { name: 'Run safe validation' }).click()
  await expect(page.getByText('Validated exploit')).toBeVisible()
  await expect(page.getByText('Exploit safely reproduced')).toBeVisible()
  await page.getByRole('button', { name: 'Build response plan' }).click()
  await expect(page.getByText('Block unapproved MCP egress')).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Approval reason' })
    .fill('Validated evidence supports this reversible containment.')
  await page.getByRole('button', { name: 'Approve response' }).click()
  await expect(page.getByText('Approved by Local demo operator')).toBeVisible()
  await page.getByRole('button', { name: 'Execute containment' }).click()
  await expect(page.getByText('Exposure removed')).toBeVisible()
  await expect(page.getByText('Residual risk unknown', { exact: true })).toBeVisible()
  await expect(page.getByText('Mitigation status does not recalculate risk')).toBeVisible()
  await expect(page.getByTestId('graph-node-agent')).toContainText('Sales Research Agent')
})

test('opens evidence from the overview snapshot graph', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/overview$/)
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await page.getByTestId('graph-node-agent').click()
  await expect(page.getByRole('dialog', { name: 'Microsoft Copilot Studio' })).toBeFocused()
  await expect(page.getByText('Published agent manifest and configured identity.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('filters the required estate facets and opens direct detail', async ({ page }) => {
  await page.goto('/agent-estate')
  await expect(page).toHaveURL(/\/agent-inventory$/)
  await expect(page.getByRole('heading', { name: 'Agent inventory', exact: true })).toBeVisible()
  await expect(page.getByText('3 of 3 agents')).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Filter agents by platform' })
    .selectOption('Azure OpenAI Service')
  await expect(page.getByText('1 of 3 agents')).toBeVisible()
  await page.getByRole('link', { name: /HR Policy Assistant/ }).click()
  await expect(page).toHaveURL(/\/agent-inventory\/hr-policy-agent$/)
  await expect(page.getByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
  await expect(page.getByLabel('Agent profile').getByText('hr-policy-agent-prod')).toBeVisible()
  await expect(page.getByText('HR Policy Knowledge Base', { exact: true })).toBeVisible()
  await expect(page.getByText('HR SharePoint MCP', { exact: true })).toBeVisible()
  await expect(page.getByText('No active findings', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Assurance scorecard', level: 2 })).toBeVisible()
  await expect(page.getByText('Governance / Compliance')).toBeVisible()
  await expect(page.getByText(/Azure AI Foundry Evaluation/)).toBeVisible()
})

test('shows assurance scorecard dimensions in agent detail', async ({ page }) => {
  await page.goto('/agent-inventory/sales-research-agent')

  const scorecard = page.getByRole('region', { name: 'Assurance scorecard' })
  await expect(
    scorecard.getByRole('heading', { name: 'Assurance scorecard', level: 2 }),
  ).toBeVisible()
  const securityCard = scorecard.getByRole('article').filter({ hasText: 'Security' })
  await expect(securityCard.getByRole('heading', { name: 'Security' })).toBeVisible()
  // Security derives from live ExposureFinding; demo agent has no live critical exposure in mock API
  await expect(securityCard.getByText('Healthy')).toBeVisible()
  const qualityCard = scorecard.getByRole('article').filter({ hasText: 'Quality' })
  await expect(qualityCard.getByRole('heading', { name: 'Quality' })).toBeVisible()
  await expect(qualityCard.getByText(/Azure AI Foundry Evaluation/)).toBeVisible()
  const reliabilityCard = scorecard.getByRole('article').filter({ hasText: 'Reliability' })
  await expect(reliabilityCard.getByRole('heading', { name: 'Reliability' })).toBeVisible()
  await expect(reliabilityCard.getByText('Unknown', { exact: true })).toBeVisible()
  await expect(
    reliabilityCard.getByText(/does not contain the exact baseline and observed runtime evidence/i),
  ).toBeVisible()
})
test('supports required routes and wildcard 404', async ({ page }) => {
  await page.goto('/agent-inventory/code-review-copilot')
  await expect(page.getByRole('heading', { name: 'Code Review Copilot' })).toBeVisible()
  await expect(page.getByText('Engineering Codebase', { exact: true })).toBeVisible()
  await expect(page.getByText('GitHub Actions MCP', { exact: true })).toBeVisible()
  await page.getByRole('main').getByRole('link', { name: 'Agent inventory' }).click()
  await expect(page).toHaveURL(/\/agent-inventory$/)
  await page.goto('/governance')
  await expect(page.getByRole('heading', { name: 'Governance' })).toBeVisible()
  await page.goto('/not-a-real-route')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})
