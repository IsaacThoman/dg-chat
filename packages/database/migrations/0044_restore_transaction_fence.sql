-- Advisory locks do not expose their session-vs-transaction lifetime through pg_locks. Bind the
-- narrow restore bypass to the exact PostgreSQL transaction instead of inferring lock lifetime.
-- The binding is written and cleared inside the all-or-nothing restore transaction, so rollback
-- cannot strand it and a same-key session advisory lock cannot masquerade as restore authority.
ALTER TABLE installation_state ADD COLUMN restore_transaction_id xid8;
ALTER TABLE installation_state ADD CONSTRAINT installation_state_restore_transaction_check
  CHECK(restore_transaction_id IS NULL OR maintenance_enabled=true);

CREATE FUNCTION dg_chat_restore_transaction_authorized(target_schema name)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path=pg_catalog
AS $$
DECLARE
  bypass_operation text;
  authorized boolean:=false;
BEGIN
  bypass_operation:=current_setting('dg_chat.restore_bypass',true);
  IF bypass_operation IS NULL OR bypass_operation !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'SELECT EXISTS(
       SELECT 1 FROM %I.installation_state state
       JOIN %I.backup_operations operation ON operation.id=state.active_restore_id
       WHERE state.singleton_id=1 AND state.maintenance_enabled=true
         AND state.active_restore_id=$1::uuid
         AND state.restore_transaction_id=pg_current_xact_id()
         AND operation.kind=''restore'' AND operation.status=''running''
         AND operation.stage=''restore_staging''
     )',
    target_schema,target_schema
  ) INTO authorized USING bypass_operation;
  RETURN COALESCE(authorized,false);
END;
$$;

CREATE OR REPLACE FUNCTION dg_chat_enforce_restore_maintenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  restore_active boolean;
  restore_authorized boolean:=false;
BEGIN
  EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
    INTO restore_authorized USING TG_TABLE_SCHEMA::name;
  IF restore_authorized THEN RETURN NULL; END IF;
  EXECUTE format(
    'SELECT maintenance_enabled FROM %I.installation_state
       WHERE singleton_id=1 FOR SHARE',TG_TABLE_SCHEMA
  ) INTO restore_active;
  IF COALESCE(restore_active,false) THEN
    RAISE EXCEPTION 'installation restore maintenance is active'
      USING ERRCODE='55000',HINT='Retry after the active restore completes.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION dg_chat_assign_ledger_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  next_sequence bigint;
  restore_authorized boolean:=false;
  locked_user uuid;
BEGIN
  IF NEW.sequence IS NOT NULL THEN
    EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
      INTO restore_authorized USING TG_TABLE_SCHEMA::name;
    IF NOT restore_authorized THEN
      RAISE EXCEPTION 'explicit ledger sequence is reserved for authorized restore'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT id FROM %I.users WHERE id=$1 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO locked_user USING NEW.user_id;
  EXECUTE format(
    'SELECT COALESCE(max(sequence),0)+1 FROM %I.ledger_entries WHERE user_id=$1',
    TG_TABLE_SCHEMA
  ) INTO next_sequence USING NEW.user_id;
  IF next_sequence>9007199254740991 THEN
    RAISE EXCEPTION 'ledger sequence exceeds safe integer range' USING ERRCODE='22003';
  END IF;
  NEW.sequence:=next_sequence;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dg_chat_fence_domain_credential_issuance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  domain record;
  restore_bypass_valid boolean:=false;
BEGIN
  -- Only revoked API-token history may bypass live issuance predicates during an installation
  -- restore, and only from the transaction durably bound to that restore operation.
  IF TG_TABLE_NAME='api_tokens' AND (to_jsonb(NEW)->>'revoked_at') IS NOT NULL THEN
    EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
      INTO restore_bypass_valid USING TG_TABLE_SCHEMA::name;
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
