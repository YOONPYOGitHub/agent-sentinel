import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('authentication readiness documentation', () => {
  it('states replacement registrations are absent and active Front Door is not protected by App Gateway WAF', () => {
    const security = rootFile('docs/security-authentication.md')
    const deployment = rootFile('docs/deployment.md')
    const runbooks = rootFile('docs/runbooks.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const readme = rootFile('README.md')

    expect(security).toContain('do not yet exist')
    expect(deployment).toContain('do not yet exist')
    expect(runbooks).toContain('do not yet exist')
    expect(knownIssues).toContain('do not yet exist')
    expect(readme).toContain('아직 존재하지 않음')
    expect(security).toContain('does **not** protect Front Door traffic')
    expect(deployment).toContain('does not protect Front Door')
    expect(runbooks).toContain('does not protect Front Door traffic')
    expect(knownIssues).toContain('does not protect Front Door')
    expect(readme).toContain('활성 Front Door를\n보호하지 않습니다')
  })

  it('documents approval/apply, role assignments, and deployment digests as blockers', () => {
    const security = rootFile('docs/security-authentication.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const readme = rootFile('README.md')

    expect(security).toContain(
      'Replacement API and SPA app registrations created through the approved bootstrap plan',
    )
    expect(security).toContain('Test principals/groups assigned to all four roles')
    expect(knownIssues).toContain('reviewed image digests')
    expect(readme).toContain('검토된 image digest')
  })
})
