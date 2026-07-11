-- Better Auth owns credentials and browser sessions while the existing users table remains the
-- authority for approval, role, account state, credits, and API-token eligibility.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN password_reset_pending boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_reset_token_identifier text;

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auth_users_email_uq UNIQUE (email)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  limited boolean NOT NULL DEFAULT true,
  CONSTRAINT auth_sessions_token_uq UNIQUE (token)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL,
  CONSTRAINT auth_accounts_provider_account_uq UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);

-- Preserve all released local credentials. Better Auth's custom password verifier understands
-- the existing PBKDF2 encoding, so this is a lossless cutover rather than a password reset.
INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at)
SELECT id, name, email, email_verified_at IS NOT NULL, created_at, updated_at
FROM users;

INSERT INTO auth_accounts (
  id, account_id, provider_id, user_id, password, created_at, updated_at
)
SELECT gen_random_uuid(), id::text, 'credential', id, password_hash, created_at, updated_at
FROM users
WHERE password_hash IS NOT NULL;

-- Keep the legacy hash during the bounded compatibility window for existing credential imports.
-- The application cutover is coordinated (old replicas must be stopped); a later contract
-- migration removes the column after compatibility sessions and tokens have expired.
