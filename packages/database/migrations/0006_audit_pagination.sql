CREATE INDEX audit_events_page_idx
  ON audit_events(created_at DESC,id DESC);
CREATE INDEX audit_events_action_page_idx
  ON audit_events(action,created_at DESC,id DESC);
CREATE INDEX audit_events_actor_page_idx
  ON audit_events(actor_id,created_at DESC,id DESC);
CREATE INDEX audit_events_target_page_idx
  ON audit_events(target_type,target_id,created_at DESC,id DESC);
CREATE INDEX audit_events_target_id_page_idx
  ON audit_events(target_id,created_at DESC,id DESC);
