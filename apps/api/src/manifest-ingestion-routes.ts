import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { ManifestIngestionRepository } from '@agent-sentinel/connector-sdk'
import { acceptManifest, normalizeManifest } from '@agent-sentinel/manifest-connector'

import { requireCapability, type AuthConfig } from './auth.js'

const requestSchema = z.strictObject({
  manifest: z.unknown().refine((value) => value !== undefined, {
    message: 'manifest is required.',
  }),
})

export interface ManifestIngestionRoutesOptions {
  authConfig: AuthConfig
  repository?: ManifestIngestionRepository
  tenantId?: string
  environmentId?: string
  writeEnabled: boolean
  clock?: () => Date
}

export function registerManifestIngestionRoutes(
  app: FastifyInstance,
  options: ManifestIngestionRoutesOptions,
): void {
  async function requireAuthentication(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (options.authConfig.mode !== 'jwt' || request.authPrincipal === undefined) {
      await reply.status(401).send({
        error: 'unauthorized',
        message: 'Authenticated manifest ingestion requires Microsoft Entra JWT mode.',
      })
    }
  }

  app.post(
    '/api/manifests/ingestions',
    {
      preHandler: [requireAuthentication, requireCapability(options.authConfig, 'configure')],
    },
    async (request, reply) => {
      const principal = request.authPrincipal
      if (principal === undefined) return
      if (!options.writeEnabled) {
        await reply.status(403).send({
          error: 'read_only_mode',
          message: 'Manifest ingestion is disabled by deployment policy.',
        })
        return
      }
      const tenantId = options.tenantId?.trim()
      const environmentId = options.environmentId?.trim()
      if (
        tenantId === undefined ||
        tenantId.length === 0 ||
        environmentId === undefined ||
        environmentId.length === 0
      ) {
        await reply.status(503).send({
          error: 'ingestion_unavailable',
          message: 'Manifest ingestion estate boundary is not configured.',
        })
        return
      }
      if (options.repository === undefined) {
        await reply.status(503).send({
          error: 'ingestion_unavailable',
          message: 'Manifest ingestion persistence is not configured.',
        })
        return
      }

      const body = requestSchema.parse(request.body)
      const acceptance = acceptManifest(body.manifest, {
        tenantId,
        environmentId,
      })
      if (!acceptance.ok) {
        await reply.status(400).send({
          error: 'manifest_rejected',
          message: 'The manifest failed validation.',
          issues: acceptance.errors,
        })
        return
      }
      const normalized = normalizeManifest(acceptance.accepted.envelope, {
        tenantId,
        environmentId,
      })
      const saved = await options.repository.save({
        tenantId,
        environmentId,
        manifestId: acceptance.accepted.envelope.manifestId,
        manifestHash: normalized.hash,
        ingestedAt: (options.clock?.() ?? new Date()).toISOString(),
        ingestedBySubject: principal.subject,
        envelope: acceptance.accepted.envelope,
        snapshot: normalized.snapshot,
      })
      await reply.status(saved.created ? 201 : 200).send({
        created: saved.created,
        manifestId: saved.record.manifestId,
        manifestHash: saved.record.manifestHash,
        ingestedAt: saved.record.ingestedAt,
        nodeCount: saved.record.snapshot.nodes.length,
        edgeCount: saved.record.snapshot.edges.length,
        evidenceCount: saved.record.snapshot.evidence.length,
        sourceOfTruth: false,
      })
    },
  )
}
