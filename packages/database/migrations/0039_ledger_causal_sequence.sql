-- A per-user causal position is authoritative for ledger replay. Wall-clock timestamps are
-- presentation metadata and cannot order transactions that commit in a different order.
ALTER TABLE ledger_entries ADD COLUMN sequence bigint;

-- Historical rows are directed accounting transitions:
--   balance_before = balance_after_micros - amount_micros
-- Reconstruct an Euler trail from balance zero for each user. This deliberately does not use
-- timestamps as causal truth; created_at/id only make the choice between equivalent outgoing
-- edges deterministic. Hierholzer's algorithm still finds a complete trail when that choice
-- initially enters a cycle, unlike a greedy linear walk.
CREATE FUNCTION dg_chat_reconstruct_ledger_sequences(
  ledger_table regclass,
  users_table regclass
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  ledger_name text:=ledger_table::text;
  users_name text:=users_table::text;
  user_row record;
  candidate record;
  bad_user uuid;
  current_balance bigint;
  stack_top bigint;
  trail_count bigint;
  completed_edge uuid;
  edge_count bigint;
  final_balance bigint;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS dg_chat_ledger_resequence_edges(
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    prior_balance bigint NOT NULL,
    balance_after bigint NOT NULL,
    created_at timestamptz NOT NULL,
    used boolean NOT NULL DEFAULT false
  ) ON COMMIT DROP;
  CREATE INDEX IF NOT EXISTS dg_chat_ledger_resequence_edges_next_idx
    ON pg_temp.dg_chat_ledger_resequence_edges(
      user_id,prior_balance,used,created_at,id
    );
  TRUNCATE pg_temp.dg_chat_ledger_resequence_edges;
  CREATE TEMP TABLE IF NOT EXISTS dg_chat_ledger_resequence_stack(
    position bigint PRIMARY KEY,
    balance bigint NOT NULL,
    edge_id uuid
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.dg_chat_ledger_resequence_stack;
  CREATE TEMP TABLE IF NOT EXISTS dg_chat_ledger_resequence_trail(
    reverse_position bigint PRIMARY KEY,
    edge_id uuid NOT NULL UNIQUE
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.dg_chat_ledger_resequence_trail;
  EXECUTE format('UPDATE %s SET sequence=NULL',ledger_name);
  EXECUTE format(
    'INSERT INTO pg_temp.dg_chat_ledger_resequence_edges(id,user_id,prior_balance,balance_after,created_at) SELECT id,user_id,balance_after_micros-amount_micros,balance_after_micros,created_at FROM %s',
    ledger_name
  );

  FOR user_row IN EXECUTE format(
    'SELECT l.user_id,u.balance_micros FROM %s l JOIN %s u ON u.id=l.user_id GROUP BY l.user_id,u.balance_micros ORDER BY l.user_id',
    ledger_name,users_name
  ) LOOP
    TRUNCATE pg_temp.dg_chat_ledger_resequence_stack;
    TRUNCATE pg_temp.dg_chat_ledger_resequence_trail;
    stack_top:=0;
    trail_count:=0;
    INSERT INTO pg_temp.dg_chat_ledger_resequence_stack(position,balance,edge_id)
      VALUES(0,0,NULL);

    WHILE stack_top>=0 LOOP
      SELECT balance INTO current_balance
      FROM pg_temp.dg_chat_ledger_resequence_stack WHERE position=stack_top;
      SELECT id,balance_after INTO candidate
      FROM pg_temp.dg_chat_ledger_resequence_edges
      WHERE user_id=user_row.user_id AND NOT used AND prior_balance=current_balance
      ORDER BY created_at,id LIMIT 1;

      IF candidate.id IS NOT NULL THEN
        UPDATE pg_temp.dg_chat_ledger_resequence_edges SET used=true WHERE id=candidate.id;
        stack_top:=stack_top+1;
        INSERT INTO pg_temp.dg_chat_ledger_resequence_stack(position,balance,edge_id)
          VALUES(stack_top,candidate.balance_after,candidate.id);
      ELSE
        SELECT edge_id INTO completed_edge
        FROM pg_temp.dg_chat_ledger_resequence_stack WHERE position=stack_top;
        DELETE FROM pg_temp.dg_chat_ledger_resequence_stack WHERE position=stack_top;
        stack_top:=stack_top-1;
        IF completed_edge IS NOT NULL THEN
          trail_count:=trail_count+1;
          INSERT INTO pg_temp.dg_chat_ledger_resequence_trail(reverse_position,edge_id)
            VALUES(trail_count,completed_edge);
        END IF;
      END IF;
    END LOOP;

    SELECT count(*) INTO edge_count FROM pg_temp.dg_chat_ledger_resequence_edges
      WHERE user_id=user_row.user_id;
    IF edge_count<>trail_count THEN
      RAISE EXCEPTION 'ledger history for user % cannot form a complete causal chain',user_row.user_id
        USING ERRCODE='23514';
    END IF;
    EXECUTE format(
      'UPDATE %s l SET sequence=$1-trail.reverse_position+1 FROM pg_temp.dg_chat_ledger_resequence_trail trail WHERE l.id=trail.edge_id',
      ledger_name
    ) USING trail_count;
    EXECUTE format(
      'SELECT balance_after_micros FROM %s WHERE user_id=$1 ORDER BY sequence DESC LIMIT 1',
      ledger_name
    ) INTO final_balance USING user_row.user_id;
    IF final_balance<>user_row.balance_micros THEN
      RAISE EXCEPTION 'ledger history for user % ends at %, expected %',
        user_row.user_id,final_balance,user_row.balance_micros USING ERRCODE='23514';
    END IF;
  END LOOP;

  EXECUTE format(
    'SELECT u.id FROM %s u LEFT JOIN LATERAL (SELECT balance_after_micros FROM %s l WHERE l.user_id=u.id ORDER BY sequence DESC LIMIT 1) latest ON true WHERE u.balance_micros<>COALESCE(latest.balance_after_micros,0) LIMIT 1',
    users_name,ledger_name
  ) INTO bad_user;
  IF bad_user IS NOT NULL THEN
    RAISE EXCEPTION 'ledger history does not match stored balance for user %',bad_user
      USING ERRCODE='23514';
  END IF;

  EXECUTE format(
    'SELECT l.user_id FROM (SELECT user_id,sequence,amount_micros,balance_after_micros,lag(balance_after_micros,1,0::bigint) OVER(PARTITION BY user_id ORDER BY sequence) prior_balance FROM %s) l WHERE l.prior_balance+l.amount_micros<>l.balance_after_micros LIMIT 1',
    ledger_name
  ) INTO bad_user;
  IF bad_user IS NOT NULL THEN
    RAISE EXCEPTION 'ledger history for user % is not causally contiguous',bad_user
      USING ERRCODE='23514';
  END IF;
END $$;

SELECT dg_chat_reconstruct_ledger_sequences('ledger_entries'::regclass,'users'::regclass);

ALTER TABLE ledger_entries ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_sequence_safe_check
  CHECK(sequence BETWEEN 1 AND 9007199254740991);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_user_sequence_uq UNIQUE(user_id,sequence);
CREATE INDEX ledger_user_sequence_page_idx
  ON ledger_entries(user_id,sequence DESC,id DESC);

CREATE FUNCTION dg_chat_assign_ledger_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_sequence bigint;
  bypass_operation text;
  restore_authorized boolean:=false;
BEGIN
  -- Restore supplies the immutable position explicitly. Normal writes serialize on the same user
  -- row used by accounting CAS/update operations, then allocate the next causal position.
  IF NEW.sequence IS NOT NULL THEN
    bypass_operation:=current_setting('dg_chat.restore_bypass',true);
    IF bypass_operation IS NOT NULL AND bypass_operation ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
      SELECT EXISTS(
        SELECT 1 FROM installation_state state
        JOIN backup_operations operation ON operation.id=state.active_restore_id
        WHERE state.singleton_id=1
          AND state.maintenance_enabled=true
          AND state.active_restore_id=bypass_operation::uuid
          AND operation.kind='restore' AND operation.status='running'
          AND operation.stage='restore_staging'
          AND EXISTS(
            SELECT 1 FROM pg_locks held
            WHERE held.locktype='advisory' AND held.pid=pg_backend_pid()
              AND held.granted=true AND held.mode='ExclusiveLock'
              AND held.classid::bigint=
                ((hashtext('dg-chat-backup-restore')::bigint >> 32) & 4294967295)
              AND held.objid::bigint=
                (hashtext('dg-chat-backup-restore')::bigint & 4294967295)
              AND held.objsubid=1
          )
      ) INTO restore_authorized;
    END IF;
    IF NOT restore_authorized THEN
      RAISE EXCEPTION 'explicit ledger sequence is reserved for authorized restore'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id=NEW.user_id FOR UPDATE;
  SELECT COALESCE(max(sequence),0)+1 INTO next_sequence
  FROM ledger_entries WHERE user_id=NEW.user_id;
  IF next_sequence>9007199254740991 THEN
    RAISE EXCEPTION 'ledger sequence exceeds safe integer range' USING ERRCODE='22003';
  END IF;
  NEW.sequence:=next_sequence;
  RETURN NEW;
END $$;

CREATE TRIGGER dg_chat_assign_ledger_sequence
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION dg_chat_assign_ledger_sequence();
