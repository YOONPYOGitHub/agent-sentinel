import { z } from 'zod'

export type LiveSourceDataState =
  | 'complete'
  | 'partial'
  | 'stale'
  | 'unsupported'
  | 'empty'
  | 'failed'
  | 'cancelled'

export interface LiveAggregationLimits {
  readonly maxSources: number
  readonly maxConcurrency: number
  readonly maxDurationMs: number
  readonly maxPagesPerSource: number
  readonly maxRecordsPerSource: number
}

export interface LiveSourceExecutionContext {
  readonly signal: AbortSignal
  readonly maxPages: number
  readonly maxRecords: number
}

export interface LiveSourceValue<T> {
  readonly state: Exclude<LiveSourceDataState, 'failed' | 'cancelled'>
  readonly value: T
  readonly pages: number
  readonly records: number
  readonly evidenceIds: readonly string[]
  readonly reason?: string
}

export interface LiveSourceOutcome<TSource, TValue> {
  readonly source: TSource
  readonly state: LiveSourceDataState
  readonly pages: number
  readonly records: number
  readonly evidenceIds: readonly string[]
  readonly value?: TValue
  readonly reason?: string
}

export interface LiveSourceAggregation<TSource, TValue> {
  readonly complete: boolean
  readonly outcomes: readonly LiveSourceOutcome<TSource, TValue>[]
}

export interface AggregateLiveSourcesOptions<TSource extends { readonly id: string }, TValue> {
  readonly sources: readonly TSource[]
  readonly limits: LiveAggregationLimits
  readonly signal?: AbortSignal
  readonly execute: (
    source: TSource,
    context: LiveSourceExecutionContext,
  ) => Promise<LiveSourceValue<TValue>>
  readonly failureReason?: (error: unknown) => string
}

const limitsSchema = z.strictObject({
  maxSources: z.number().int().min(1).max(10_000),
  maxConcurrency: z.number().int().min(1).max(100),
  maxDurationMs: z.number().int().min(1).max(60 * 60 * 1_000),
  maxPagesPerSource: z.number().int().min(1).max(100_000),
  maxRecordsPerSource: z.number().int().min(1).max(1_000_000),
})

function cancelledOutcome<TSource, TValue>(
  source: TSource,
  reason: 'cancelled' | 'duration-exceeded',
): LiveSourceOutcome<TSource, TValue> {
  return {
    source,
    state: 'cancelled',
    pages: 0,
    records: 0,
    evidenceIds: [],
    reason,
  }
}

export async function aggregateLiveSources<
  TSource extends { readonly id: string },
  TValue,
>(
  options: AggregateLiveSourcesOptions<TSource, TValue>,
): Promise<LiveSourceAggregation<TSource, TValue>> {
  const limits = limitsSchema.parse(options.limits)
  if (options.sources.length > limits.maxSources) {
    throw new Error(
      `Configured live source count exceeds maxSources (${options.sources.length} > ${limits.maxSources}).`,
    )
  }
  const sourceIds = new Set<string>()
  for (const source of options.sources) {
    if (sourceIds.has(source.id)) throw new Error('Live source IDs must be unique.')
    sourceIds.add(source.id)
  }

  const controller = new AbortController()
  let cancellationReason: 'cancelled' | 'duration-exceeded' | undefined
  const abort = (reason: 'cancelled' | 'duration-exceeded'): void => {
    if (controller.signal.aborted) return
    cancellationReason = reason
    controller.abort(reason)
  }
  const onExternalAbort = (): void => abort('cancelled')
  if (options.signal?.aborted === true) onExternalAbort()
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const deadline = setTimeout(() => abort('duration-exceeded'), limits.maxDurationMs)
  deadline.unref()

  const outcomes = new Array<LiveSourceOutcome<TSource, TValue> | undefined>(
    options.sources.length,
  )
  let nextIndex = 0
  const executeSource = async (index: number): Promise<void> => {
    const source = options.sources[index]!
    if (controller.signal.aborted) {
      outcomes[index] = cancelledOutcome(source, cancellationReason ?? 'cancelled')
      return
    }
    let removeAbortListener = (): void => undefined
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new Error(cancellationReason ?? 'cancelled'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort)
    })
    try {
      const result = await Promise.race([
        options.execute(source, {
          signal: controller.signal,
          maxPages: limits.maxPagesPerSource,
          maxRecords: limits.maxRecordsPerSource,
        }),
        aborted,
      ])
      if (controller.signal.aborted) {
        outcomes[index] = cancelledOutcome(source, cancellationReason ?? 'cancelled')
        return
      }
      if (
        !Number.isInteger(result.pages) ||
        result.pages < 0 ||
        !Number.isInteger(result.records) ||
        result.records < 0
      ) {
        outcomes[index] = {
          source,
          state: 'failed',
          pages: 0,
          records: 0,
          evidenceIds: [],
          reason: 'invalid-measurement',
        }
        return
      }
      const bounded =
        result.pages > limits.maxPagesPerSource || result.records > limits.maxRecordsPerSource
      outcomes[index] = {
        source,
        state: bounded ? 'partial' : result.state,
        pages: result.pages,
        records: result.records,
        evidenceIds: [...result.evidenceIds],
        value: result.value,
        ...(bounded
          ? { reason: 'bounds' }
          : result.reason === undefined
            ? {}
            : { reason: result.reason }),
      }
    } catch (error: unknown) {
      outcomes[index] = controller.signal.aborted
        ? cancelledOutcome(source, cancellationReason ?? 'cancelled')
        : {
            source,
            state: 'failed',
            pages: 0,
            records: 0,
            evidenceIds: [],
            reason: options.failureReason?.(error) ?? 'source-failed',
          }
    } finally {
      removeAbortListener()
    }
  }
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= options.sources.length) return
      await executeSource(index)
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(limits.maxConcurrency, options.sources.length) },
        async () => worker(),
      ),
    )
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }

  for (const [index, source] of options.sources.entries()) {
    outcomes[index] ??= cancelledOutcome(source, cancellationReason ?? 'cancelled')
  }
  const completedOutcomes = outcomes as LiveSourceOutcome<TSource, TValue>[]
  return {
    complete: completedOutcomes.every((outcome) => outcome.state === 'complete'),
    outcomes: completedOutcomes,
  }
}
