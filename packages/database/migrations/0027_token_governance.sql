ALTER TABLE api_tokens ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE api_tokens ADD COLUMN rpm_limit integer;
ALTER TABLE api_tokens ADD COLUMN burst_limit integer;
ALTER TABLE api_tokens ADD COLUMN access_mode text NOT NULL DEFAULT 'inherit';
ALTER TABLE api_tokens ADD COLUMN rotation_family_id uuid;
ALTER TABLE api_tokens ADD COLUMN rotation_generation integer NOT NULL DEFAULT 0;
ALTER TABLE api_tokens ADD COLUMN rotated_from_token_id uuid;
ALTER TABLE api_tokens ADD COLUMN replaced_by_token_id uuid;
ALTER TABLE api_tokens ADD COLUMN overlap_ends_at timestamptz;
UPDATE api_tokens SET rotation_family_id=id WHERE rotation_family_id IS NULL;
ALTER TABLE api_tokens ALTER COLUMN rotation_family_id SET NOT NULL;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_version_check CHECK(version >= 1);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_generation_check CHECK(rotation_generation >= 0);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_rpm_check CHECK(rpm_limit IS NULL OR rpm_limit BETWEEN 1 AND 60000);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_burst_check CHECK(burst_limit IS NULL OR burst_limit BETWEEN 1 AND 1000);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_rate_relation_check CHECK(rpm_limit IS NULL OR burst_limit IS NULL OR burst_limit <= rpm_limit);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_access_mode_check CHECK(access_mode IN ('inherit','restricted'));
CREATE UNIQUE INDEX api_tokens_family_generation_uq ON api_tokens(rotation_family_id,rotation_generation);
CREATE UNIQUE INDEX api_tokens_family_id_uq ON api_tokens(rotation_family_id,id);
CREATE UNIQUE INDEX api_tokens_user_id_uq ON api_tokens(user_id,id);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_rotated_from_fk FOREIGN KEY(rotation_family_id,rotated_from_token_id) REFERENCES api_tokens(rotation_family_id,id) ON DELETE RESTRICT;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_replaced_by_fk FOREIGN KEY(rotation_family_id,replaced_by_token_id) REFERENCES api_tokens(rotation_family_id,id) ON DELETE RESTRICT;

CREATE TABLE model_aliases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alias text NOT NULL,
 target_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT,
 description text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT model_aliases_alias_check CHECK(alias ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$'),
 CONSTRAINT model_aliases_version_check CHECK(version >= 1)
);
CREATE UNIQUE INDEX model_aliases_alias_uq ON model_aliases(alias);
CREATE TABLE access_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 description text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT access_groups_version_check CHECK(version >= 1)
);
CREATE UNIQUE INDEX access_groups_name_uq ON access_groups(lower(name));
CREATE TABLE access_group_users (
 group_id uuid NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,user_id)
);
CREATE TABLE access_group_models (
 group_id uuid NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
 provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,provider_model_id)
);
CREATE TABLE access_group_tokens (
 group_id uuid NOT NULL, token_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(group_id,token_id),
 FOREIGN KEY(group_id,user_id) REFERENCES access_group_users(group_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,token_id) REFERENCES api_tokens(user_id,id) ON DELETE CASCADE
);
CREATE INDEX access_group_models_model_idx ON access_group_models(provider_model_id,group_id);
CREATE INDEX access_group_tokens_token_idx ON access_group_tokens(token_id,group_id);
