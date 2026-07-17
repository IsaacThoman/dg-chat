-- A credential is valid only in the monotonic authority generation in which it was issued.
-- Restoring an account never rewinds this value, so credentials and requests admitted before
-- suspension, rejection, deletion, or password reset cannot regain authority afterward.
ALTER TABLE users ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE users ADD CONSTRAINT users_authority_epoch_check
  CHECK(authority_epoch BETWEEN 1 AND 9007199254740991);

ALTER TABLE sessions ADD COLUMN authority_epoch bigint;
ALTER TABLE auth_sessions ADD COLUMN authority_epoch bigint;
ALTER TABLE api_tokens ADD COLUMN authority_epoch bigint;
ALTER TABLE identity_tokens ADD COLUMN authority_epoch bigint;
-- OIDC state and other Better Auth verifications do not represent domain-user authority.
-- Only password-reset records carry an epoch.
ALTER TABLE auth_verifications ADD COLUMN authority_epoch bigint;

UPDATE sessions s SET authority_epoch=u.authority_epoch FROM users u WHERE u.id=s.user_id;
UPDATE auth_sessions s SET authority_epoch=COALESCE(u.authority_epoch,1)
  FROM auth_users a LEFT JOIN users u ON u.id=a.id WHERE a.id=s.user_id;
UPDATE api_tokens t SET authority_epoch=u.authority_epoch FROM users u WHERE u.id=t.user_id;
UPDATE identity_tokens t SET authority_epoch=u.authority_epoch FROM users u WHERE u.id=t.user_id;
UPDATE auth_verifications v SET authority_epoch=u.authority_epoch FROM users u
  WHERE v.identifier LIKE 'reset-password:%' AND v.value=u.id::text AND
    u.state='active' AND u.deleted_at IS NULL AND u.password_reset_pending=false;
-- Old Better Auth reset records that cannot be tied to currently eligible domain authority
-- must not survive as unfenced capabilities or prevent the reset-only consistency constraint.
DELETE FROM auth_verifications v WHERE v.identifier LIKE 'reset-password:%' AND NOT EXISTS(
  SELECT 1 FROM users u WHERE u.id::text=v.value AND u.state='active' AND
    u.deleted_at IS NULL AND u.password_reset_pending=false
);

ALTER TABLE sessions ALTER COLUMN authority_epoch SET DEFAULT 1;
ALTER TABLE sessions ALTER COLUMN authority_epoch SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_authority_epoch_check
  CHECK(authority_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE auth_sessions ALTER COLUMN authority_epoch SET DEFAULT 1;
ALTER TABLE auth_sessions ALTER COLUMN authority_epoch SET NOT NULL;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_authority_epoch_check
  CHECK(authority_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE api_tokens ALTER COLUMN authority_epoch SET DEFAULT 1;
ALTER TABLE api_tokens ALTER COLUMN authority_epoch SET NOT NULL;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_authority_epoch_check
  CHECK(authority_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE identity_tokens ALTER COLUMN authority_epoch SET DEFAULT 1;
ALTER TABLE identity_tokens ALTER COLUMN authority_epoch SET NOT NULL;
ALTER TABLE identity_tokens ADD CONSTRAINT identity_tokens_authority_epoch_check
  CHECK(authority_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE auth_verifications ADD CONSTRAINT auth_verifications_authority_epoch_check CHECK(
  (identifier LIKE 'reset-password:%' AND
    authority_epoch BETWEEN 1 AND 9007199254740991) OR
  (identifier NOT LIKE 'reset-password:%' AND authority_epoch IS NULL)
);

CREATE OR REPLACE FUNCTION dg_chat_fence_auth_session_issuance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  domain_approval text;
  domain_state text;
  domain_deleted_at timestamptz;
  domain_password_reset_pending boolean;
  domain_authority_epoch bigint;
  domain_found boolean;
BEGIN
  EXECUTE format(
    'SELECT approval_status::text,state::text,deleted_at,password_reset_pending,
            authority_epoch,true
       FROM %I.users WHERE id=$1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO domain_approval,domain_state,domain_deleted_at,domain_password_reset_pending,
      domain_authority_epoch,domain_found USING NEW.user_id;

  IF domain_found IS NOT TRUE THEN
    IF NEW.limited IS TRUE AND NEW.authority_epoch=1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'authentication session requires a provisioned domain authority'
      USING ERRCODE='42501';
  END IF;
  IF NEW.authority_epoch<>domain_authority_epoch THEN
    RAISE EXCEPTION 'authentication session authority epoch is stale' USING ERRCODE='42501';
  END IF;
  IF domain_state<>'active' OR domain_deleted_at IS NOT NULL OR
      domain_password_reset_pending IS TRUE THEN
    RAISE EXCEPTION 'authentication session issuance denied by account lifecycle'
      USING ERRCODE='42501';
  END IF;
  IF NEW.limited IS NOT TRUE AND domain_approval<>'approved' THEN
    RAISE EXCEPTION 'full authentication session requires account approval'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dg_chat_fence_domain_credential_issuance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  domain record;
  restore_operation text;
  restore_bypass_valid boolean := false;
BEGIN
  -- Installation restores preserve revoked API-token history at its original authority epoch.
  -- The transaction-local setting is not trusted by itself: re-prove the durable maintenance
  -- owner and this backend's exact transaction-level advisory lock before bypassing issuance
  -- checks. Active tokens and every normal insert still require current live authority below.
  IF TG_TABLE_NAME='api_tokens' AND (to_jsonb(NEW)->>'revoked_at') IS NOT NULL THEN
    restore_operation := current_setting('dg_chat.restore_bypass', true);
    IF restore_operation IS NOT NULL AND restore_operation ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
      EXECUTE format(
        'SELECT EXISTS(
           SELECT 1 FROM %I.installation_state state
           JOIN %I.backup_operations operation ON operation.id=state.active_restore_id
           WHERE state.singleton_id=1 AND state.maintenance_enabled=true
             AND state.active_restore_id=$1::uuid AND operation.kind=''restore''
             AND operation.status=''running'' AND operation.stage=''restore_staging''
             AND EXISTS(
               SELECT 1 FROM pg_catalog.pg_locks held
               WHERE held.locktype=''advisory'' AND held.pid=pg_backend_pid()
                 AND held.granted=true AND held.mode=''ExclusiveLock''
                 AND held.classid::bigint =
                   ((hashtext(''dg-chat-backup-restore'')::bigint >> 32) & 4294967295)
                 AND held.objid::bigint =
                   (hashtext(''dg-chat-backup-restore'')::bigint & 4294967295)
                 AND held.objsubid=1
             )
         )',
        TG_TABLE_SCHEMA,TG_TABLE_SCHEMA
      ) INTO restore_bypass_valid USING restore_operation;
    END IF;
    IF restore_bypass_valid THEN RETURN NEW; END IF;
  END IF;
  EXECUTE format(
    'SELECT approval_status::text approval,state::text state,deleted_at,
            password_reset_pending,authority_epoch FROM %I.users WHERE id=$1 FOR UPDATE',
    TG_TABLE_SCHEMA
  ) INTO domain USING NEW.user_id;
  IF domain IS NULL OR NEW.authority_epoch<>domain.authority_epoch OR
      domain.state<>'active' OR domain.deleted_at IS NOT NULL OR
      domain.password_reset_pending IS TRUE OR
      (TG_TABLE_NAME='api_tokens' AND domain.approval<>'approved') OR
      (TG_TABLE_NAME='sessions' AND
        COALESCE((to_jsonb(NEW)->>'limited')::boolean,false) IS NOT TRUE AND
        domain.approval<>'approved') THEN
    RAISE EXCEPTION 'credential issuance denied by account authority' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dg_chat_legacy_session_authority_fence BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_domain_credential_issuance();
CREATE TRIGGER dg_chat_api_token_authority_fence BEFORE INSERT ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_domain_credential_issuance();
CREATE TRIGGER dg_chat_identity_token_authority_fence BEFORE INSERT ON identity_tokens
  FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_domain_credential_issuance();

CREATE OR REPLACE FUNCTION dg_chat_fence_auth_verification_issuance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE domain record;
BEGIN
  IF NEW.identifier LIKE 'reset-password:%' THEN
    EXECUTE format(
      'SELECT authority_epoch,state::text,deleted_at,password_reset_pending
         FROM %I.users WHERE id::text=$1 FOR UPDATE', TG_TABLE_SCHEMA
    ) INTO domain USING NEW.value;
    IF domain IS NULL OR NEW.authority_epoch IS NULL OR
        NEW.authority_epoch<>domain.authority_epoch OR domain.state<>'active' OR
        domain.deleted_at IS NOT NULL OR domain.password_reset_pending IS TRUE THEN
      RAISE EXCEPTION 'password reset authority epoch is stale' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dg_chat_auth_verification_authority_fence BEFORE INSERT ON auth_verifications
  FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_auth_verification_issuance();

CREATE OR REPLACE FUNCTION dg_chat_credential_epoch_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch THEN
    RAISE EXCEPTION 'credential authority epoch is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dg_chat_sessions_epoch_immutable BEFORE UPDATE OF authority_epoch ON sessions
  FOR EACH ROW EXECUTE FUNCTION dg_chat_credential_epoch_immutable();
CREATE TRIGGER dg_chat_auth_sessions_epoch_immutable BEFORE UPDATE OF authority_epoch ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION dg_chat_credential_epoch_immutable();
CREATE TRIGGER dg_chat_api_tokens_epoch_immutable BEFORE UPDATE OF authority_epoch ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION dg_chat_credential_epoch_immutable();
CREATE TRIGGER dg_chat_identity_tokens_epoch_immutable BEFORE UPDATE OF authority_epoch ON identity_tokens
  FOR EACH ROW EXECUTE FUNCTION dg_chat_credential_epoch_immutable();
CREATE TRIGGER dg_chat_auth_verifications_epoch_immutable BEFORE UPDATE OF authority_epoch ON auth_verifications
  FOR EACH ROW EXECUTE FUNCTION dg_chat_credential_epoch_immutable();
