import type { Pool } from 'pg'

import type { ValidationRun, ValidationRunRepository } from '@agent-sentinel/domain'

interface ValidationRunRow {
  data: ValidationRun
}

export class PgValidationRunRepository implements ValidationRunRepository {
  constructor(private readonly pool: Pool) {}

  async save(run: ValidationRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO validation_runs (id, finding_id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET finding_id = EXCLUDED.finding_id, data = EXCLUDED.data, updated_at = NOW()`,
      [run.id, run.findingId, run],
    )
  }

  async findById(id: string): Promise<ValidationRun | null> {
    const result = await this.pool.query<ValidationRunRow>(
      'SELECT data FROM validation_runs WHERE id = $1',
      [id],
    )
    return result.rows[0]?.data ?? null
  }

  async findByFindingId(findingId: string): Promise<ValidationRun[]> {
    const result = await this.pool.query<ValidationRunRow>(
      'SELECT data FROM validation_runs WHERE finding_id = $1 ORDER BY created_at DESC',
      [findingId],
    )
    return result.rows.map((row) => row.data)
  }

  async update(id: string, patch: Partial<ValidationRun>): Promise<ValidationRun> {
    const result = await this.pool.query<ValidationRunRow>(
      'UPDATE validation_runs SET data = data || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING data',
      [id, patch],
    )
    const run = result.rows[0]?.data
    if (!run) {
      throw new Error(`Validation run not found: ${id}`)
    }
    return run
  }
}
