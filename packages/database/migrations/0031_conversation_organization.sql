CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
  theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('light','dark','system')),
  compact_conversations boolean NOT NULL DEFAULT false,
  reduce_motion boolean NOT NULL DEFAULT false,
  custom_instructions text NOT NULL DEFAULT '' CHECK(char_length(custom_instructions) <= 20000),
  use_memory boolean NOT NULL DEFAULT false,
  save_history boolean NOT NULL DEFAULT true,
  preferred_model_id text CHECK(preferred_model_id IS NULL OR char_length(preferred_model_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD CONSTRAINT conversations_id_owner_uq UNIQUE(id,owner_id);

CREATE TABLE conversation_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120 AND name=btrim(name)),
  normalized_name text NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
  membership_version integer NOT NULL DEFAULT 0 CHECK(membership_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_folders_normalized_check CHECK(normalized_name=translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
  CONSTRAINT conversation_folders_id_owner_uq UNIQUE(id,owner_id),
  CONSTRAINT conversation_folders_owner_name_uq UNIQUE(owner_id,normalized_name),
  CONSTRAINT conversation_folders_owner_position_uq UNIQUE(owner_id,position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX conversation_folders_owner_position_idx ON conversation_folders(owner_id,position,id);

CREATE TABLE conversation_folder_memberships (
  folder_id uuid NOT NULL, conversation_id uuid PRIMARY KEY, owner_id uuid NOT NULL,
  position integer NOT NULL CHECK(position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_folder_memberships_folder_owner_fk FOREIGN KEY(folder_id,owner_id)
    REFERENCES conversation_folders(id,owner_id) ON DELETE CASCADE,
  CONSTRAINT conversation_folder_memberships_conversation_owner_fk FOREIGN KEY(conversation_id,owner_id)
    REFERENCES conversations(id,owner_id) ON DELETE CASCADE,
  CONSTRAINT conversation_folder_memberships_position_uq UNIQUE(folder_id,position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX conversation_folder_memberships_owner_idx ON conversation_folder_memberships(owner_id,folder_id,position);

CREATE TABLE conversation_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 64 AND name=btrim(name)), normalized_name text NOT NULL,
  color text NOT NULL CHECK(color ~ '^#[0-9A-Fa-f]{6}$'), version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_tags_normalized_check CHECK(normalized_name=translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
  CONSTRAINT conversation_tags_id_owner_uq UNIQUE(id,owner_id),
  CONSTRAINT conversation_tags_owner_name_uq UNIQUE(owner_id,normalized_name)
);
CREATE INDEX conversation_tags_owner_name_idx ON conversation_tags(owner_id,normalized_name,id);

CREATE TABLE conversation_tag_sets (
  conversation_id uuid PRIMARY KEY, owner_id uuid NOT NULL, version integer NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_tag_sets_conversation_owner_uq UNIQUE(conversation_id,owner_id),
  CONSTRAINT conversation_tag_sets_conversation_owner_fk FOREIGN KEY(conversation_id,owner_id)
    REFERENCES conversations(id,owner_id) ON DELETE CASCADE
);

CREATE TABLE conversation_tag_bindings (
  conversation_id uuid NOT NULL, tag_id uuid NOT NULL, owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,tag_id),
  CONSTRAINT conversation_tag_bindings_conversation_owner_fk FOREIGN KEY(conversation_id,owner_id)
    REFERENCES conversation_tag_sets(conversation_id,owner_id) ON DELETE CASCADE,
  CONSTRAINT conversation_tag_bindings_tag_owner_fk FOREIGN KEY(tag_id,owner_id)
    REFERENCES conversation_tags(id,owner_id) ON DELETE CASCADE
);
CREATE INDEX conversation_tag_bindings_owner_idx ON conversation_tag_bindings(owner_id,conversation_id,tag_id);

CREATE FUNCTION dg_chat_enforce_organizable_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversations c WHERE c.id=NEW.conversation_id AND c.owner_id=NEW.owner_id
      AND c.temporary=false AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation cannot be organized' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_folder_memberships_organizable BEFORE INSERT OR UPDATE
  ON conversation_folder_memberships FOR EACH ROW EXECUTE FUNCTION dg_chat_enforce_organizable_conversation();
CREATE TRIGGER conversation_tag_sets_organizable BEFORE INSERT OR UPDATE
  ON conversation_tag_sets FOR EACH ROW EXECUTE FUNCTION dg_chat_enforce_organizable_conversation();
CREATE TRIGGER conversation_tag_bindings_organizable BEFORE INSERT OR UPDATE
  ON conversation_tag_bindings FOR EACH ROW EXECUTE FUNCTION dg_chat_enforce_organizable_conversation();

CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON user_preferences FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON conversation_folders FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON conversation_folder_memberships FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON conversation_tags FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON conversation_tag_sets FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
CREATE TRIGGER dg_chat_restore_maintenance_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON conversation_tag_bindings FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
