import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function section(markdown: string, heading: string, nextHeading: string): string {
  const start = markdown.indexOf(heading)
  const end = markdown.indexOf(nextHeading, start + heading.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return markdown.slice(start, end)
}

describe('authentication readiness documentation', () => {
  it('keeps replacement authentication and active-edge safety semantically blocked', () => {
    const security = rootFile('docs/security-authentication.md')
    const deployment = rootFile('docs/deployment.md')
    const runbooks = rootFile('docs/runbooks.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const currentStatus = rootFile('docs/current-status.md')
    const handoff = rootFile('docs/maintainer-handoff.md')
    const production = section(rootFile('README.md'), '## Production readiness', '## Quick start')
    const operationalDocuments = [
      security,
      deployment,
      runbooks,
      knownIssues,
      currentStatus,
      handoff,
    ]
    const operationalTruth = operationalDocuments.join('\n')

    expect(operationalTruth).toMatch(
      /replacement[\s\S]*(API|SPA)[\s\S]*(registrations?|service principals?)[\s\S]*(exist|created|생성 완료)/i,
    )
    expect(operationalTruth).toMatch(
      /(admin consent|role assignment|역할 할당)[\s\S]*(incomplete|pending|미완료)/i,
    )
    expect(operationalTruth).toContain('AUTH_MODE=disabled')
    expect(operationalTruth).toMatch(
      /Front Door[\s\S]*(no evidenced|does not protect)[\s\S]*mutation/i,
    )
    expect(operationalTruth).toMatch(/write(s|Enabled)?[\s\S]*(false|disabled|prohibited|금지)/i)
    for (const document of operationalDocuments) {
      expect(document).toMatch(/Front Door/i)
      expect(document).toMatch(/write|mutation/i)
    }

    expect(production).toMatch(
      /replacement API\/SPA[^|\n]*생성 완료[^|\n]*(consent|역할 할당) 미완료/,
    )
    expect(production).toContain('`AUTH_MODE=disabled`')
    expect(production).toMatch(/Front Door (write guard|mutation rule)/)
  })

  it('documents approval, all four roles, and immutable deployment evidence as blockers', () => {
    const security = rootFile('docs/security-authentication.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const handoff = rootFile('docs/maintainer-handoff.md')
    const production = section(rootFile('README.md'), '## Production readiness', '## Quick start')

    expect(security).toMatch(/registration[s]? created through the approved bootstrap plan/i)
    expect(security).toMatch(/all four roles/i)
    expect(handoff).toMatch(/Viewer[\s\S]*Analyst[\s\S]*Approver[\s\S]*Administrator/)
    expect(knownIssues).toMatch(/reviewed image digests/i)
    expect(handoff).toMatch(/human[\s\S]{0,180}approv/i)
    expect(production).toContain('`Viewer`·`Analyst`·`Approver`·`Administrator`')
    expect(production).toMatch(/full SHA[^|\n]*image digest|full SHA[^|\n]*digest/)
  })
})
