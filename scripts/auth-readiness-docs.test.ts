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
  it('keeps replacement authentication and active-edge safety explicitly blocked', () => {
    const security = rootFile('docs/security-authentication.md')
    const deployment = rootFile('docs/deployment.md')
    const runbooks = rootFile('docs/runbooks.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const production = section(rootFile('README.md'), '## Production readiness', '## Quick start')

    expect(security).toContain('do not yet exist')
    expect(deployment).toContain('do not yet exist')
    expect(runbooks).toContain('do not yet exist')
    expect(knownIssues).toContain('do not yet exist')
    expect(production).toMatch(/replacement API\/SPA[^|\n]*(미생성|없)/)
    expect(production).toContain('`AUTH_MODE=disabled`')
    expect(security).toContain('does **not** protect Front Door traffic')
    expect(deployment).toContain('does not protect Front Door')
    expect(runbooks).toContain('does not protect Front Door traffic')
    expect(knownIssues).toContain('does not protect Front Door')
    expect(production).toMatch(/Front Door (write guard|mutation rule)/)
  })

  it('documents approval, all four roles, and immutable deployment evidence as blockers', () => {
    const security = rootFile('docs/security-authentication.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const production = section(rootFile('README.md'), '## Production readiness', '## Quick start')

    expect(security).toContain(
      'Replacement API and SPA app registrations created through the approved bootstrap plan',
    )
    expect(security).toContain('Test principals/groups assigned to all four roles')
    expect(knownIssues).toContain('reviewed image digests')
    expect(production).toContain('`Viewer`·`Analyst`·`Approver`·`Administrator`')
    expect(production).toMatch(/full SHA[^|\n]*image digest|full SHA[^|\n]*digest/)
  })
})
