export interface MessageDeduplicator {
  isDuplicate(messageId: string): Promise<boolean>
  markProcessed(messageId: string): Promise<void>
}

export class InMemoryDeduplicator implements MessageDeduplicator {
  private readonly processed = new Set<string>()

  isDuplicate(id: string): Promise<boolean> {
    return Promise.resolve(this.processed.has(id))
  }

  markProcessed(id: string): Promise<void> {
    this.processed.add(id)
    return Promise.resolve()
  }
}

export async function withIdempotency<T>(
  deduplicator: MessageDeduplicator,
  messageId: string,
  handler: () => Promise<T>,
): Promise<T | null> {
  if (await deduplicator.isDuplicate(messageId)) {
    return null
  }
  const result = await handler()
  await deduplicator.markProcessed(messageId)
  return result
}
