import { describe, expect, it } from 'vitest'

import {
  containsRepeatedNgram,
  exactYesNo,
  hasSubstantialKoreanText,
  rowsToCsv,
  summarizeRows,
  type OneRaiSafetyRow,
} from './onerai-safety-report.js'

function row(overrides: Partial<OneRaiSafetyRow> = {}): OneRaiSafetyRow {
  return {
    caseId: 'case-1',
    trial: 1,
    harm: 'Ungrounded',
    scenario: 'Explicit policy fact',
    agent: 'agent',
    agentId: 'agent-id',
    agentVersion: '1',
    manifestHash: 'a'.repeat(64),
    language: 'English',
    input: 'input',
    output: 'output',
    serviceOutcome: 'agent-response',
    filterTypes: [],
    toolNames: [],
    responseIds: ['response-id'],
    defect: false,
    defectReason: 'Grounded answer matched.',
    ...overrides,
  }
}

describe('OneRAI safety report', () => {
  it('recognizes substantial Korean output', () => {
    expect(hasSubstantialKoreanText('에이전트의 목적과 안전 경계를 한국어로 설명합니다.')).toBe(
      true,
    )
    expect(hasSubstantialKoreanText('한국어 short')).toBe(false)
  })

  it('accepts only exact yes or no answers', () => {
    expect(exactYesNo('YES.')).toBe('YES')
    expect(exactYesNo('no')).toBe('NO')
    expect(exactYesNo('Yes, external transfer is prohibited.')).toBeUndefined()
  })

  it('detects repeated protected-material ngrams', () => {
    const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
    expect(
      containsRepeatedNgram(source, 'beta gamma delta epsilon zeta eta theta iota copied'),
    ).toBe(true)
    expect(containsRepeatedNgram(source, 'A short independent summary.')).toBe(false)
  })

  it('summarizes every configured harm without treating missing rows as evaluated', () => {
    const summaries = summarizeRows([
      row(),
      row({ caseId: 'case-2', defect: true, defectReason: 'Mismatch.' }),
    ])
    expect(summaries.find((summary) => summary.harm === 'Ungrounded')).toEqual({
      harm: 'Ungrounded',
      inputs: 2,
      defects: 1,
      defectRate: 0.5,
    })
    expect(
      summaries.find(
        (summary) => summary.harm === 'Harmful Content (Hate, Violence, Sexual, Self Harm)',
      ),
    ).toMatchObject({ inputs: 0, defects: 0, defectRate: null })
  })

  it('writes escaped, row-oriented CSV', () => {
    const csv = rowsToCsv([row({ input: 'hello, "world"', output: 'line 1\nline 2' })])
    expect(csv).toContain('"hello, ""world"""')
    expect(csv).toContain('"line 1\nline 2"')
  })

  it('neutralizes spreadsheet formulas in untrusted text cells', () => {
    const csv = rowsToCsv([
      row({
        input: '=HYPERLINK("https://example.invalid")',
        output: '\t+cmd|calc',
        defectReason: '@SUM(1+1)',
      }),
    ])
    expect(csv).toContain(`"'=HYPERLINK(""https://example.invalid"")"`)
    expect(csv).toContain(`"'\t+cmd|calc"`)
    expect(csv).toContain(`'@SUM(1+1)`)
  })
})
