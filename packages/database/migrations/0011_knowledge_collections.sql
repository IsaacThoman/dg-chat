CREATE TABLE knowledge_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,160}$'), version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX knowledge_collections_owner_updated_idx ON knowledge_collections(owner_id,updated_at DESC,id);
CREATE TABLE knowledge_collection_attachments (
  collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(collection_id,attachment_id)
);
CREATE TABLE conversation_knowledge_bindings (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, mode text NOT NULL CHECK (mode IN ('retrieval','full_context')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,collection_id)
);
CREATE INDEX conversation_knowledge_owner_idx ON conversation_knowledge_bindings(owner_id,conversation_id);
CREATE FUNCTION enforce_knowledge_attachment_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM knowledge_collections k JOIN attachments a ON a.id=NEW.attachment_id WHERE k.id=NEW.collection_id AND k.owner_id=a.owner_id AND k.deleted_at IS NULL AND a.deleted_at IS NULL AND a.state='ready')
THEN RAISE EXCEPTION 'knowledge attachment ownership mismatch' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER knowledge_attachment_owner BEFORE INSERT OR UPDATE ON knowledge_collection_attachments FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_attachment_owner();
CREATE FUNCTION enforce_conversation_knowledge_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM conversations c JOIN knowledge_collections k ON k.id=NEW.collection_id WHERE c.id=NEW.conversation_id AND c.owner_id=NEW.owner_id AND k.owner_id=NEW.owner_id AND c.deleted_at IS NULL AND k.deleted_at IS NULL)
THEN RAISE EXCEPTION 'conversation knowledge ownership mismatch' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER conversation_knowledge_owner BEFORE INSERT OR UPDATE ON conversation_knowledge_bindings FOR EACH ROW EXECUTE FUNCTION enforce_conversation_knowledge_owner();
