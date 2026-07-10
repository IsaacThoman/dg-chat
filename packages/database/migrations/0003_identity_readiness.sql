ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at=now() WHERE approval_status='approved';

CREATE TABLE identity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_tokens_user_purpose_idx ON identity_tokens(user_id,purpose);
