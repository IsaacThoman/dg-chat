-- Consent for installation-wide community rankings is deliberately isolated from ordinary user
-- preferences. Defaults disclose nothing, and the database enforces the same narrow identity
-- surface as the public contract.
CREATE TABLE community_profiles(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opted_in boolean NOT NULL DEFAULT false,
  identity_mode text NOT NULL DEFAULT 'anonymous'
    CHECK(identity_mode IN ('anonymous','nickname')),
  nickname text,
  color text NOT NULL DEFAULT 'slate'
    CHECK(color IN ('slate','blue','cyan','emerald','amber','orange','rose','violet')),
  share_balance boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_profiles_nickname_check CHECK(
    (identity_mode='anonymous' AND nickname IS NULL) OR
    (identity_mode='nickname' AND nickname IS NOT NULL
      AND char_length(nickname) BETWEEN 2 AND 32
      AND nickname=btrim(nickname)
      AND nickname ~ '^[A-Za-z0-9]([A-Za-z0-9_. -]{0,30}[A-Za-z0-9])?$')
  ),
  CONSTRAINT community_profiles_consent_check CHECK(opted_in OR NOT share_balance)
);

-- Full-installation restore owns this table while maintenance mode is active. Owner-scoped
-- conversation portability intentionally has no relationship to it and therefore cannot carry
-- installation community consent to another account or installation.
CREATE TRIGGER dg_chat_restore_maintenance_fence
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON community_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_restore_maintenance();
