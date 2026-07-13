ALTER TABLE conversations ADD COLUMN temporary_expires_at timestamptz;

UPDATE conversations
SET temporary_expires_at=created_at+interval '30 days'
WHERE temporary=true;

ALTER TABLE conversations ADD CONSTRAINT conversations_temporary_expiry_check CHECK (
  (temporary=true AND temporary_expires_at IS NOT NULL) OR
  (temporary=false AND temporary_expires_at IS NULL)
);

-- Owner-leading ordering keeps tenant maintenance bounded and prevents one owner's
-- cleanup from scanning or locking another owner's temporary conversations.
CREATE INDEX conversations_owner_temporary_expiry_idx
  ON conversations(owner_id,temporary_expires_at,id) WHERE temporary=true;
