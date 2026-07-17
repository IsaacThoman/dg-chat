-- Better Auth calls its session.create.before hook before its adapter eventually inserts the
-- session. A lifecycle transition can commit in that gap, so application-side validation alone
-- cannot prevent a delayed full session from being inserted after revocation. Serialize the
-- durable insert with lifecycle authority changes by taking the same domain-user row lock.
--
-- A new signup is the deliberate exception: Better Auth can create its status-only session just
-- before user.create.after provisions the domain row. Missing-domain sessions must therefore be
-- limited, and request authorization continues to fail closed until provisioning completes.
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
  domain_found boolean;
BEGIN
  -- Qualify the sibling domain table with the trigger table's own schema. This supports custom
  -- deployment schemas without leaving relation resolution open to an invoker-controlled
  -- search_path.
  EXECUTE format(
    'SELECT approval_status::text,state::text,deleted_at,password_reset_pending,true
       FROM %I.users WHERE id=$1 FOR UPDATE',
    TG_TABLE_SCHEMA
  )
    INTO domain_approval,domain_state,domain_deleted_at,domain_password_reset_pending,domain_found
    USING NEW.user_id;

  -- Dynamic EXECUTE does not update PL/pgSQL's FOUND flag, so use an explicit selected marker.
  IF domain_found IS NOT TRUE THEN
    IF NEW.limited IS TRUE THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'full authentication session requires a provisioned domain user'
      USING ERRCODE='42501';
  END IF;

  IF domain_state <> 'active' OR domain_deleted_at IS NOT NULL OR
      domain_password_reset_pending IS TRUE THEN
    RAISE EXCEPTION 'authentication session issuance denied by account lifecycle'
      USING ERRCODE='42501';
  END IF;

  IF NEW.limited IS NOT TRUE AND domain_approval <> 'approved' THEN
    RAISE EXCEPTION 'full authentication session requires account approval'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dg_chat_auth_session_issuance_fence ON auth_sessions;
CREATE TRIGGER dg_chat_auth_session_issuance_fence
  BEFORE INSERT ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION dg_chat_fence_auth_session_issuance();
