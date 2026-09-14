import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/ci-build-deploy.yml', import.meta.url),
  'utf8',
)
const scriptsPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>
}

describe('release review workflow integration', () => {
  it('invokes the dry-run guard exactly once and validates the exact generated SHA', () => {
    expect(scriptsPackage.scripts['release-review:dry-run']).toBe(
      'tsx generate-release-review-bundle.ts',
    )
    expect(workflow).toMatch(/pnpm release-review:dry-run -- \\\n\s+--dry-run \\\n\s+--sha "\$SHA"/)
    expect(workflow).toContain('release-evidence/v2/templates/sanitized-input.template.json')
    expect(workflow).toContain('"$REVIEW_OUTPUT/release-review-v2-$SHA.json"')
  })
})
