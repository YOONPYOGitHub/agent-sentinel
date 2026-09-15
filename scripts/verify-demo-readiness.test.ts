import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parseVerifyDemoArgs,
  verifyDemoReadiness,
  type DemoVerificationReport,
} from './verify-demo-readiness.js'

const directory = dirname(fileURLToPath(import.meta.url))
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  delete process.env['VERIFIER_TEST_TOKEN']
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done())
        }),
    ),
  )
})

async function fixtureServer(): Promise<string> {
  const fixture = JSON.parse(
    await readFile(resolve(directory, 'test-fixtures/demo-readiness-ready.json'), 'utf8'),
  ) as Record<string, { status: number; headers?: Record<string, string>; body: unknown }>
  const server = createServer((request, response) => {
    const entry = fixture[request.url ?? '']
    if (request.method !== 'GET' || entry === undefined) {
      response.writeHead(404).end()
      return
    }
    const responseBody =
      request.url === '/api/auth/config' && typeof entry.body === 'object' && entry.body !== null
        ? {
            ...entry.body,
            redirectUri: `http://${request.headers.host}/auth/callback`,
            postLogoutRedirectUri: `http://${request.headers.host}/`,
          }
        : entry.body
    const body = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
    response.writeHead(entry.status, {
      'content-type': typeof responseBody === 'string' ? 'text/plain' : 'application/json',
      ...entry.headers,
    })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server failed.')
  return `http://127.0.0.1:${address.port}`
}

function runCli(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'verify-demo-readiness.ts', ...args], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

describe('release readiness verifier CLI', () => {
  it('parses bounded immutable version expectations', () => {
    expect(
      parseVerifyDemoArgs([
        '--url',
        'https://example.test/',
        '--timeout-ms',
        '5000',
        '--max-response-bytes',
        '1048576',
        '--expected-web-sha',
        'a'.repeat(40),
        '--expected-api-digest',
        `sha256:${'b'.repeat(64)}`,
      ]),
    ).toMatchObject({
      baseUrl: 'https://example.test',
      timeoutMs: 5000,
      maxResponseBytes: 1048576,
      expected: {
        webSha: 'a'.repeat(40),
        apiDigest: `sha256:${'b'.repeat(64)}`,
      },
    })
  })

  it('rejects credentials, duplicate options, and unbounded settings', () => {
    expect(() => parseVerifyDemoArgs(['--url', 'https://user:secret@example.test'])).toThrow(
      'without credentials',
    )
    expect(() =>
      parseVerifyDemoArgs(['--url', 'https://example.test', '--url', 'https://other.test']),
    ).toThrow('may be provided only once')
    expect(() =>
      parseVerifyDemoArgs(['--url', 'https://example.test', '--timeout-ms', '60001']),
    ).toThrow('between 1 and 60000')
  })

  it('reads an optional bearer token only from the named environment variable', async () => {
    process.env['VERIFIER_TEST_TOKEN'] = 'private-test-token'
    const authorization: Array<string | null> = []
    const report = await verifyDemoReadiness(
      {
        baseUrl: 'https://example.test',
        tokenEnvironment: 'VERIFIER_TEST_TOKEN',
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        expected: {},
      },
      (_url, init) => {
        authorization.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve(new Response('{}', { status: 503 }))
      },
    )
    delete process.env['VERIFIER_TEST_TOKEN']
    expect(authorization).toHaveLength(7)
    expect(authorization.filter((value) => value === 'Bearer private-test-token')).toHaveLength(3)
    expect(authorization.filter((value) => value === null)).toHaveLength(4)
    expect(JSON.stringify(report)).not.toContain('private-test-token')
  })

  it('marks timed-out requests unavailable', async () => {
    const report = await verifyDemoReadiness(
      {
        baseUrl: 'https://example.test',
        timeoutMs: 5,
        maxResponseBytes: 1024,
        expected: {},
      },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    expect(report.overall).toBe('unavailable')
    expect(report.requests.every((item) => item.outcome === 'timeout')).toBe(true)
  })

  it('fails closed when a response exceeds the byte limit', async () => {
    const report = await verifyDemoReadiness(
      {
        baseUrl: 'https://example.test',
        timeoutMs: 1000,
        maxResponseBytes: 16,
        expected: {},
      },
      () => Promise.resolve(new Response('x'.repeat(32), { status: 200 })),
    )
    expect(report.overall).toBe('unavailable')
    expect(report.requests.every((item) => item.outcome === 'response-too-large')).toBe(true)
  })

  it('runs end-to-end against fixture GET endpoints and emits sanitized JSON', async () => {
    const baseUrl = await fixtureServer()
    const sha = 'd'.repeat(40)
    const digest = `sha256:${'e'.repeat(64)}`
    const result = await runCli([
      '--url',
      baseUrl,
      '--output',
      '-',
      '--expected-web-sha',
      sha,
      '--expected-api-sha',
      sha,
      '--expected-jobs-sha',
      sha,
      '--expected-web-digest',
      digest,
      '--expected-api-digest',
      digest,
      '--expected-jobs-digest',
      digest,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as DemoVerificationReport
    expect(report.overall).toBe('ready')
    expect(report.readiness?.agent365.packageEvidenceCount).toBe(1)
    expect(report.readiness?.runsAs.exactEdgeCount).toBe(1)
    expect(report.readiness?.otel.liveInvocationCount).toBe(1)
    expect(report.version.apiHeadersMatchStatus).toBe(true)
    expect(result.stderr).toContain('release readiness: READY')
    expect(result.stdout).not.toContain('Package agent')
    expect(result.stdout).not.toContain('11111111-1111-4111-8111-111111111111')
    expect(result.stdout).not.toContain('59dbea72-1e91-403a-89cf-e02cdb8da350')
  })
})
