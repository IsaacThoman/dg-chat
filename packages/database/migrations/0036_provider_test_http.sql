-- Provider URL policy is environment-aware at the repository and transport layers:
-- production accepts HTTPS only, while contract tests may opt one exact Docker host
-- into HTTP. Keep the storage constraint structural so it does not contradict that
-- deliberately narrow runtime exception.
ALTER TABLE providers DROP CONSTRAINT providers_base_url_check;

ALTER TABLE providers ADD CONSTRAINT providers_base_url_check CHECK (
  char_length(base_url) BETWEEN 1 AND 2048 AND
  base_url ~ '^https?://[^/?#@]+(?:/[^?#@]*)?$'
);
