import { expect, test } from '@playwright/test'

test('connectors page renders the management readiness surface', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Active connection status' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connector source configuration' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connector catalog' })).toBeVisible()
})

test('connector source management preserves exact IDs and honest read-only health', async ({
  page,
}) => {
  await page.route('**/api/connector-sources?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            estateId: 'default',
            tenantId: 'tenant-demo',
            environment: 'validation',
            sourceId: 'primary',
            connectorType: 'foundry',
            displayName: 'Deployment Foundry',
            enabled: false,
            origin: 'deployment',
            configuration: {
              type: 'foundry',
              projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/primary',
            },
            credential: { mode: 'default' },
            testStatus: {
              status: 'degraded',
              evidenceBasis: 'provider-response',
              evidenceIds: ['provider-evidence'],
              checkedAt: '2020-01-01T00:00:00.000Z',
              checkedBy: { type: 'deployment', id: 'deployment-json' },
              summary: 'Provider returned a partial response.',
            },
            version: 1,
            etag: 'deployment-etag',
            createdBy: { type: 'deployment', id: 'deployment-json' },
            updatedBy: { type: 'deployment', id: 'deployment-json' },
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
        ],
        page: { limit: 50, nextCursor: null },
        mutationPolicy: {
          enabled: false,
          requiresAuthentication: true,
          requiredCapability: 'configure',
        },
      }),
    })
  })
  await page.route('**/api/connector-sources/primary/connection-test-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        estateId: 'default',
        tenantId: 'tenant-demo',
        environment: 'validation',
        sourceId: 'primary',
        connectorType: 'foundry',
        readOnly: true,
        status: 'unknown',
        evidenceAvailability: 'unavailable',
        evidenceBasis: null,
        evidenceIds: [],
        checkedAt: null,
        checkedBy: null,
        summary: 'No evidence-backed connection test has been recorded.',
      }),
    })
  })

  await page.goto('/connectors')
  const source = page.getByRole('article', { name: 'Deployment Foundry' })
  await expect(source).toContainText('primary')
  await expect(source).toContainText('Disabled')
  await expect(source).toContainText('Deployment managed')
  await expect(source).toContainText('Stale')
  await expect(page.getByRole('button', { name: 'Add connector source' })).toBeDisabled()
  await expect(page.getByText(/deployment write gate is disabled/i)).toBeVisible()

  await source.getByRole('button', { name: 'Check test evidence' }).click()
  await expect(source.getByRole('status')).toContainText('Unknown')
  await expect(source.getByRole('status')).toContainText(
    'No evidence-backed connection test has been recorded.',
  )
})

test('connector source pagination labels synthetic evidence and suppresses duplicate page requests', async ({
  page,
}) => {
  let cursorRequests = 0
  const source = {
    estateId: 'default',
    tenantId: 'tenant-demo',
    environment: 'validation',
    sourceId: 'primary',
    connectorType: 'foundry',
    displayName: 'Synthetic Foundry',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'foundry',
      projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/primary',
    },
    credential: { mode: 'default' },
    testStatus: {
      status: 'degraded',
      evidenceBasis: 'synthetic',
      evidenceIds: ['synthetic-evidence'],
      checkedAt: '2026-09-06T00:00:00.000Z',
      checkedBy: { type: 'user', id: 'administrator-object-id' },
      summary: 'A bounded synthetic probe observed a degraded result.',
    },
    version: 1,
    etag: 'etag-one',
    createdBy: { type: 'user', id: 'administrator-object-id' },
    updatedBy: { type: 'user', id: 'administrator-object-id' },
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }
  const mutationPolicy = {
    enabled: false,
    requiresAuthentication: true,
    requiredCapability: 'configure',
  }

  await page.route('**/api/connector-sources?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    if (cursor === null) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [source],
          page: { limit: 50, nextCursor: 'primary' },
          mutationPolicy,
        }),
      })
      return
    }

    cursorRequests += 1
    await new Promise((resolve) => setTimeout(resolve, 150))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            ...source,
            displayName: 'Synthetic Foundry updated',
            etag: 'etag-two',
            version: 2,
          },
          {
            ...source,
            sourceId: 'later',
            displayName: 'Later source',
            etag: 'etag-later',
          },
        ],
        page: { limit: 50, nextCursor: null },
        mutationPolicy,
      }),
    })
  })

  await page.goto('/connectors')
  const synthetic = page.getByRole('article', { name: 'Synthetic Foundry' })
  await expect(synthetic).toContainText('Synthetic evidence - not live provider evidence')

  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Load more sources',
    )
    button?.click()
    button?.click()
  })

  await expect(page.getByRole('button', { name: 'Loading more...' })).toBeDisabled()
  await expect(page.getByRole('article', { name: 'Later source' })).toBeVisible()
  expect(cursorRequests).toBe(1)
  await expect(page.locator('.connector-source-grid > article')).toHaveCount(2)
  await expect(page.locator('.connector-source-grid > article').nth(0)).toHaveAttribute(
    'aria-label',
    'Synthetic Foundry updated',
  )
  await expect(page.locator('.connector-source-grid > article').nth(1)).toHaveAttribute(
    'aria-label',
    'Later source',
  )
})

test('connectors page shows active connector details', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  // In demo/mock mode the active connector is the mock estate
  await expect(
    page.getByRole('heading', { name: /Mock agent estate|Azure AI Foundry/i }).first(),
  ).toBeVisible()
})

test('connectors page lists expected catalog entries', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Azure AI Foundry' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Microsoft Agent 365' })).toBeVisible()
  await expect(
    page.getByRole('article', { name: 'Microsoft Entra Agent ID & Entitlements' }),
  ).toBeVisible()
})

test('Agent 365 shows authorization required, not connected', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  const agent365 = page.getByRole('article', { name: 'Microsoft Agent 365' })
  await expect(agent365).toContainText('Authorization required')
  await expect(agent365).not.toContainText('Connected')
})

test('Entra distinction notice is visible', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('note')).toContainText(
    'Entra ID authentication vs. entitlement evidence',
  )
})

test('connector catalog shows scorecard unlock information', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  const foundryCard = page.getByRole('article', { name: 'Azure AI Foundry' })
  await expect(foundryCard).toContainText('Unlocks:')
})

test('help menu links to connector management', async ({ page }) => {
  await page.goto('/overview')
  await page.getByRole('button', { name: 'Help and diagnostics' }).click()
  const connectorLink = page.getByRole('link', { name: /connector management/i })
  await expect(connectorLink).toBeVisible()
  await connectorLink.click()
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
})

test('refresh button reloads connector status', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh status' }).click()
  // Page should remain functional after refresh
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
})
