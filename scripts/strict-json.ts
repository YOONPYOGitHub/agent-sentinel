class DuplicateJsonKeyError extends SyntaxError {}

function invalidJson(): never {
  throw new SyntaxError('Invalid JSON.')
}

export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  let offset = 0

  function skipWhitespace(): void {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset] ?? '')) offset += 1
  }

  function scanString(): string {
    if (text[offset] !== '"') invalidJson()
    const start = offset
    offset += 1
    while (offset < text.length) {
      const character = text[offset]
      if (character === '"') {
        offset += 1
        try {
          return JSON.parse(text.slice(start, offset)) as string
        } catch {
          return invalidJson()
        }
      }
      if (character === '\\') {
        offset += 2
        continue
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) invalidJson()
      offset += 1
    }
    return invalidJson()
  }

  function scanObject(): void {
    offset += 1
    skipWhitespace()
    if (text[offset] === '}') {
      offset += 1
      return
    }

    const keys = new Set<string>()
    while (offset < text.length) {
      const key = scanString()
      if (keys.has(key)) throw new DuplicateJsonKeyError('Duplicate JSON object key.')
      keys.add(key)
      skipWhitespace()
      if (text[offset] !== ':') invalidJson()
      offset += 1
      scanValue()
      skipWhitespace()
      if (text[offset] === '}') {
        offset += 1
        return
      }
      if (text[offset] !== ',') invalidJson()
      offset += 1
      skipWhitespace()
    }
    invalidJson()
  }

  function scanArray(): void {
    offset += 1
    skipWhitespace()
    if (text[offset] === ']') {
      offset += 1
      return
    }

    while (offset < text.length) {
      scanValue()
      skipWhitespace()
      if (text[offset] === ']') {
        offset += 1
        return
      }
      if (text[offset] !== ',') invalidJson()
      offset += 1
      skipWhitespace()
    }
    invalidJson()
  }

  function scanValue(): void {
    skipWhitespace()
    const character = text[offset]
    if (character === '{') {
      scanObject()
      return
    }
    if (character === '[') {
      scanArray()
      return
    }
    if (character === '"') {
      scanString()
      return
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length
        return
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number?.[0] !== undefined) {
      offset += number[0].length
      return
    }
    invalidJson()
  }

  scanValue()
  skipWhitespace()
  if (offset !== text.length) invalidJson()
  return JSON.parse(text) as unknown
}

export function isDuplicateJsonKeyError(error: unknown): boolean {
  return error instanceof DuplicateJsonKeyError
}
