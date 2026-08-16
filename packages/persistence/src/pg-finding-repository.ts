import type { Pool } from 'pg'

import type { Finding, FindingRepository } from '@agent-sentinel/domain'

type TenantFinding = Finding & { tenantId: string }

interface FindingRow {
  data: Finding
}

function getTenantId(finding: Finding): string {
  const tenantId = (finding as Partial<TenantFinding>).tenantId
  if (!tenantId) {
    throw new Error('Finding must include tenantId for persistence')
  }
  return tenantId
}

export class PgFindingRepository implements FindingRepository {
  constructor(private readonly pool: Pool) {}

  async save(finding: Finding): Promise<void> {
    await this.pool.query(
      `INSERT INTO findings (id, tenant_id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id, data = EXCLUDED.data, updated_at = NOW()`,
      [finding.id, getTenantId(finding), finding],
    )
  }

  async findById(id: string): Promise<Finding | null> {
    const result = await this.pool.query<FindingRow>('SELECT data FROM findings WHERE id = $1', [
      id,
    ])
    return result.rows[0]?.data ?? null
  }

  async listByTenantAndSeverity(tenantId: string, severity?: string): Promise<Finding[]> {
    const values: string[] = [tenantId]
    let query = 'SELECT data FROM findings WHERE tenant_id = $1'
    if (severity !== undefined) {
      query += ` AND data->>'severity' = $2`
      values.push(severity)
    }
    query += ' ORDER BY created_at DESC'
    const result = await this.pool.query<FindingRow>(query, values)
    return result.rows.map((row) => row.data)
  }

  async update(id: string, patch: Partial<Finding>): Promise<Finding> {
    const result = await this.pool.query<FindingRow>(
      'UPDATE findings SET data = data || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING data',
      [id, patch],
    )
    const finding = result.rows[0]?.data
    if (!finding) {
      throw new Error(`Finding not found: ${id}`)
    }
    return finding
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM findings WHERE id = $1', [id])
  }
}
