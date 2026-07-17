import postgres from "npm:postgres@3.4.7";

type Sql = ReturnType<typeof postgres>;

export interface StartupEmbeddingIdentity {
  model: string;
  version: string;
}

const BATCH_SIZE = 100;

/**
 * Reconciles one independently committed batch. A large installation therefore makes durable
 * forward progress even when total startup reconciliation takes longer than statement_timeout.
 */
export async function reconcileGeneratedCleanupBatch(
  sql: Sql,
  graceSeconds: number,
): Promise<number> {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; owner_id: string }[]>`
      WITH candidates AS (
        SELECT s.id FROM generated_object_staging s
        WHERE s.state IN ('pending','stored','attached','cleaning')
          AND s.updated_at < now() - ${graceSeconds} * interval '1 second'
          AND NOT EXISTS(SELECT 1 FROM generated_assets ga WHERE ga.usage_run_id=s.usage_run_id)
          AND NOT EXISTS(SELECT 1 FROM api_idempotency_requests r
            WHERE r.usage_run_id=s.usage_run_id AND r.state='in_progress'
              AND r.lease_expires_at>now())
          AND NOT EXISTS(SELECT 1 FROM usage_runs u WHERE u.id=s.usage_run_id
            AND u.status='reserved' AND u.run_lease_expires_at>now())
        ORDER BY s.updated_at,s.id FOR UPDATE SKIP LOCKED LIMIT ${BATCH_SIZE}
      )
      UPDATE generated_object_staging s SET state='cleanup_pending',
        cleanup_error=COALESCE(cleanup_error,'stale generated object stage'),updated_at=now()
      FROM candidates c WHERE s.id=c.id RETURNING s.id,s.owner_id`;
    for (const row of rows) {
      await tx`INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
        VALUES('generated_object.cleanup',${
        tx.json({ stageId: String(row.id), ownerId: String(row.owner_id) })
      },${`generated_object.cleanup:${String(row.id)}`},'queued',0,now())
        ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
          last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
          WHERE jobs.status IN ('completed','failed')`;
    }
    return rows.length;
  });
}

export async function reconcileEmbeddingJobsBatch(
  sql: Sql,
  identity: StartupEmbeddingIdentity,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    WITH candidates AS (
      SELECT a.id,a.owner_id FROM attachments a
      WHERE a.deleted_at IS NULL AND a.state='ready' AND a.ingestion_status='ready'
        AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.attachment_id=a.id)
        AND EXISTS (
          SELECT 1 FROM document_chunks dc WHERE dc.attachment_id=a.id AND NOT EXISTS (
            SELECT 1 FROM document_chunk_embeddings dce WHERE dce.chunk_id=dc.id
              AND dce.owner_id=a.owner_id AND dce.model=${identity.model}::text
              AND dce.embedding_version=${identity.version}::text
          )
        )
        AND NOT EXISTS (SELECT 1 FROM jobs j
          WHERE j.idempotency_key='document.embed:' || a.id || ':' || ${identity.version}::text
            AND j.status IN ('queued','running','failed'))
      ORDER BY a.created_at,a.id LIMIT ${BATCH_SIZE}
    )
    INSERT INTO jobs(type,payload,idempotency_key,status,attempts,available_at)
      SELECT 'document.embed',jsonb_build_object(
        'attachmentId',c.id,'ownerId',c.owner_id,'version',${identity.version}::text
      ),'document.embed:' || c.id || ':' || ${identity.version}::text,'queued',0,now()
      FROM candidates c
    ON CONFLICT(idempotency_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
      last_error=NULL,locked_at=NULL,locked_by=NULL,completed_at=NULL
      WHERE jobs.status='completed'
    RETURNING id`;
  return rows.length;
}

export async function reconcileStartupQueues(
  sql: Sql,
  options: {
    generatedCleanupGraceSeconds: number;
    embedding?: StartupEmbeddingIdentity;
    signal: AbortSignal;
  },
): Promise<{ cleanup: number; embeddings: number }> {
  let cleanup = 0;
  let embeddings = 0;
  while (true) {
    options.signal.throwIfAborted();
    const count = await reconcileGeneratedCleanupBatch(
      sql,
      options.generatedCleanupGraceSeconds,
    );
    cleanup += count;
    if (count < BATCH_SIZE) break;
  }
  if (options.embedding) {
    while (true) {
      options.signal.throwIfAborted();
      const count = await reconcileEmbeddingJobsBatch(sql, options.embedding);
      embeddings += count;
      if (count < BATCH_SIZE) break;
    }
  }
  return { cleanup, embeddings };
}
