import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const cosmosBicep = readFileSync(
  resolve(import.meta.dirname, '../infra/modules/cosmos.bicep'),
  'utf8',
)

describe('connector sources Cosmos container', () => {
  it('uses an estate partition and dedicated source/audit indexes', () => {
    expect(cosmosBicep).toMatch(
      /name:\s*'connector-sources'[\s\S]*?partitionKey:\s*\{[\s\S]*?paths:\s*\['\/estateId'\][\s\S]*?kind:\s*'Hash'/,
    )
    for (const path of [
      '/documentType/?',
      '/tenantId/?',
      '/environment/?',
      '/source/sourceId/?',
      '/source/updatedAt/?',
      '/deleted/?',
      '/sourceId/?',
      '/occurredAt/?',
      '/audit/id/?',
    ]) {
      expect(cosmosBicep).toContain(`path: '${path}'`)
    }
    expect(cosmosBicep).toMatch(
      /path:\s*'\/source\/updatedAt'[\s\S]*?order:\s*'descending'[\s\S]*?path:\s*'\/source\/sourceId'[\s\S]*?order:\s*'ascending'/,
    )
    expect(cosmosBicep).toMatch(
      /path:\s*'\/occurredAt'[\s\S]*?order:\s*'ascending'[\s\S]*?path:\s*'\/audit\/id'[\s\S]*?order:\s*'ascending'/,
    )
  })

  it('preserves private identity-only Cosmos access', () => {
    expect(cosmosBicep).toContain('disableLocalAuth: true')
    expect(cosmosBicep).toContain("publicNetworkAccess: 'Disabled'")
    expect(cosmosBicep).toContain('privateEndpointSubnetId')
  })
})
