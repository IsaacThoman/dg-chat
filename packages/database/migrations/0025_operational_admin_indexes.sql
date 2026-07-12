CREATE INDEX "usage_runs_analytics_time_idx" ON "usage_runs" ("created_at" DESC, "id");
CREATE INDEX "usage_runs_analytics_user_time_idx" ON "usage_runs" ("user_id", "created_at" DESC, "id");
CREATE INDEX "jobs_admin_page_idx" ON "jobs" ("created_at" DESC, "id" DESC);
