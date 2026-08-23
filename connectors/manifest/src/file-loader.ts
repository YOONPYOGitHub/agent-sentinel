import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'

/** Hard ceiling on manifest size. Fail closed rather than stream unbounded input. */
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024

export class ManifestFileLoadError extends Error {
  override readonly name = 'ManifestFileLoadError'
}

/**
 * Validate an operator-supplied manifest path.
 *
 * The adapter never performs network access, so anything that is not a plain
 * local absolute file path is rejected before the filesystem is touched:
 * URLs (`http://`, `https://`, `file://`, any scheme), protocol-relative
 * `//host/...` references, UNC paths, relative paths, traversal segments, and
 * embedded NUL bytes.
 */
export function assertSafeManifestPath(candidate: string): string {
  const value = candidate.trim()
  if (value === '') throw new ManifestFileLoadError('manifestPath must not be empty.')
  if (value.includes('\0')) throw new ManifestFileLoadError('manifestPath must not contain NUL.')
  if (value.includes('://'))
    throw new ManifestFileLoadError(
      `manifestPath must be a local file path; remote URLs are rejected: ${value}`,
    )
  if (value.startsWith('//') || value.startsWith('\\\\'))
    throw new ManifestFileLoadError(
      `manifestPath must not be protocol-relative or a UNC path: ${value}`,
    )
  if (!isAbsolute(value)) throw new ManifestFileLoadError(`manifestPath must be absolute: ${value}`)
  const normalized = normalize(value)
  if (normalized !== value)
    throw new ManifestFileLoadError(
      `manifestPath must already be normalized without traversal segments: ${value}`,
    )
  return normalized
}

/**
 * Read and JSON-parse a manifest from the local filesystem through one file
 * descriptor. The pre-open and post-open identity check prevents a path from
 * being swapped between validation and the bounded read.
 */
export async function loadManifestFile(candidate: string): Promise<unknown> {
  const path = assertSafeManifestPath(candidate)

  let handle: FileHandle | undefined
  let raw: string
  try {
    const beforeOpen = await lstat(path)
    if (!beforeOpen.isFile())
      throw new ManifestFileLoadError(
        `manifestPath must reference a regular file (symbolic links are rejected): ${path}`,
      )

    const noFollow = constants.O_NOFOLLOW ?? 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== beforeOpen.dev ||
      (beforeOpen.ino !== 0 && opened.ino !== beforeOpen.ino)
    )
      throw new ManifestFileLoadError(
        `manifestPath changed during validation or resolved through a symbolic link: ${path}`,
      )

    if (opened.size > MAX_MANIFEST_BYTES)
      throw new ManifestFileLoadError(
        `Manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit: ${opened.size} bytes.`,
      )

    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_MANIFEST_BYTES)
      throw new ManifestFileLoadError(
        `Manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit while being read.`,
      )
    raw = buffer.toString('utf8', 0, bytesRead)
  } catch (error: unknown) {
    if (error instanceof ManifestFileLoadError) throw error
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'ELOOP')
      throw new ManifestFileLoadError(
        `manifestPath must reference a regular file (symbolic links are rejected): ${path}`,
      )
    throw new ManifestFileLoadError(
      `manifestPath could not be read: ${error instanceof Error ? error.message : 'unknown filesystem error'}`,
    )
  } finally {
    if (handle !== undefined) await handle.close()
  }

  try {
    return JSON.parse(raw) as unknown
  } catch (error: unknown) {
    throw new ManifestFileLoadError(
      `Manifest is not valid JSON: ${error instanceof Error ? error.message : 'parse failure'}`,
    )
  }
}
