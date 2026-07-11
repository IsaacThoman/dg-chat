import postgres from "npm:postgres@3.4.7";

export interface BetterAuthReconciliationResult {
  usersInserted: number;
  credentialsInserted: number;
}

/**
 * Reconciles identities imported after migrations (notably legacy runtime snapshots) before the
 * API begins accepting traffic. It never rebinds or overwrites an existing credential.
 */
export async function reconcileBetterAuthIdentities(
  databaseUrl: string,
): Promise<BetterAuthReconciliationResult> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('dg-chat-better-auth-reconciliation'))`;
      const conflicts = await tx<{ domain_id: string; auth_id: string }[]>`
        SELECT u.id::text domain_id,au.id::text auth_id
        FROM users u
        JOIN auth_users au ON lower(au.email)=lower(u.email)
        WHERE au.id<>u.id
        LIMIT 1
      `;
      if (conflicts.length) {
        throw new Error("Better Auth reconciliation found an email/identity conflict");
      }
      const mappingConflicts = await tx<{ id: string }[]>`
        SELECT u.id::text id
        FROM users u JOIN auth_users au ON au.id=u.id
        WHERE lower(au.email)<>lower(u.email)
        LIMIT 1
      `;
      if (mappingConflicts.length) {
        throw new Error("Better Auth reconciliation found an ID/email mapping conflict");
      }
      const credentialConflicts = await tx<{ account_id: string }[]>`
        SELECT aa.account_id
        FROM auth_accounts aa JOIN users u ON aa.account_id=u.id::text
        WHERE aa.provider_id='credential' AND aa.user_id<>u.id
        LIMIT 1
      `;
      if (credentialConflicts.length) {
        throw new Error("Better Auth reconciliation found a credential ownership conflict");
      }
      const unusableCredentials = await tx<{ account_id: string }[]>`
        SELECT aa.account_id
        FROM auth_accounts aa JOIN users u ON aa.account_id=u.id::text
        WHERE aa.provider_id='credential' AND u.password_hash IS NOT NULL AND aa.password IS NULL
        LIMIT 1
      `;
      if (unusableCredentials.length) {
        throw new Error("Better Auth reconciliation found an unusable credential");
      }

      const insertedUsers = await tx`
        INSERT INTO auth_users(id,name,email,email_verified,created_at,updated_at)
        SELECT u.id,u.name,u.email,u.email_verified_at IS NOT NULL,u.created_at,u.updated_at
        FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM auth_users au WHERE au.id=u.id)
        RETURNING id
      `;
      const insertedCredentials = await tx`
        INSERT INTO auth_accounts(
          id,account_id,provider_id,user_id,password,created_at,updated_at
        )
        SELECT gen_random_uuid(),u.id::text,'credential',u.id,u.password_hash,u.created_at,u.updated_at
        FROM users u
        WHERE u.password_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM auth_accounts aa
            WHERE aa.provider_id='credential' AND aa.account_id=u.id::text
          )
        RETURNING id
      `;
      return {
        usersInserted: insertedUsers.length,
        credentialsInserted: insertedCredentials.length,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
