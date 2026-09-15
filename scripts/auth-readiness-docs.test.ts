import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function section(markdown: string, anchorId: string, nextAnchorId: string): string {
  const anchor = `<a id="${anchorId}"></a>`
  const start = markdown.indexOf(anchor)
  const end = markdown.indexOf(`<a id="${nextAnchorId}"></a>`, start + anchor.length)
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
    const production = section(rootFile('README.md'), 'production-readiness', 'quick-start')
    const operationalDocuments = [
      security,
      deployment,
      runbooks,
      knownIssues,
      currentStatus,
      handoff,
    ]
    expect(currentStatus).toMatch(/대체 API[^\n]*SPA[^\n]*등록[^\n]*서비스 주체[^\n]*존재/)
    expect(currentStatus).toMatch(/관리자 동의[^\n]*역할 할당[^\n]*미완료/)
    expect(currentStatus).toContain('AUTH_MODE=disabled')
    expect(currentStatus).toMatch(/Front Door[^\n]*사용자 지정 변경 요청 규칙[^\n]*확인되지 않/)
    expect(currentStatus).toMatch(/중지된 Application Gateway[^\n]*Front Door를 보호하지 않/)
    expect(currentStatus).toContain('AGENT_SENTINEL_WRITE_ENABLED=false')
    for (const document of operationalDocuments) {
      expect(document).toMatch(/Front Door/i)
      expect(document).toMatch(/write|mutation|쓰기|변경 요청/i)
    }

    expect(production).toMatch(
      /대체 API·SPA[^|\n]*생성 완료[^|\n]*관리자 동의[^|\n]*역할 할당 미완료/,
    )
    expect(production).toContain('`AUTH_MODE=disabled`')
    expect(production).toContain('`AGENT_SENTINEL_WRITE_ENABLED=false`')
    expect(production).toMatch(/Front Door 변경 요청 규칙/)
  })

  it('documents approval, all four roles, and immutable deployment evidence as blockers', () => {
    const security = rootFile('docs/security-authentication.md')
    const knownIssues = rootFile('docs/known-issues.md')
    const handoff = rootFile('docs/maintainer-handoff.md')
    const production = section(rootFile('README.md'), 'production-readiness', 'quick-start')

    expect(security).toMatch(/승인된 부트스트랩 계획[^\n]*API[^\n]*SPA[^\n]*등록/)
    expect(security).toMatch(/4개 역할 모두/)
    expect(handoff).toMatch(/Viewer[\s\S]*Analyst[\s\S]*Approver[\s\S]*Administrator/)
    expect(knownIssues).toMatch(/검토된 이미지 다이제스트/)
    expect(handoff).toMatch(/사람[^\n]{0,180}승인/)
    expect(production).toContain('`Viewer`·`Analyst`·`Approver`·`Administrator`')
    expect(production).toMatch(/전체 SHA[^|\n]*다이제스트/)
  })
})
