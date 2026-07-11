CREATE FUNCTION provider_model_capabilities_are_valid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'array' THEN false
    ELSE
      candidate <@ '["chat","streaming","vision","tools","reasoning","embeddings","audio_input","transcription","translation","speech","image_generation","image_edit"]'::jsonb
      AND jsonb_array_length(candidate) = (
        SELECT count(DISTINCT value)
        FROM jsonb_array_elements_text(candidate) AS capability(value)
      )
  END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM provider_models
    WHERE NOT provider_model_capabilities_are_valid(capabilities)
  ) THEN
    RAISE EXCEPTION 'provider_models contains unsupported or duplicate capability values'
      USING HINT = 'Repair provider_models.capabilities using unique values from the canonical capability list before retrying migration 0020.';
  END IF;
END $$;

ALTER TABLE provider_models
  DROP CONSTRAINT provider_models_capabilities_check;

ALTER TABLE provider_models
  ADD CONSTRAINT provider_models_capabilities_check
  CHECK (provider_model_capabilities_are_valid(capabilities));
