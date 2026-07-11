# syntax=docker/dockerfile:1.7

FROM denoland/deno:alpine AS dependencies
WORKDIR /workspace
ENV DENO_DIR=/deno-dir
COPY deno.json package.json deno.lock ./
COPY apps/api/deno.json apps/api/deno.json
COPY apps/mock-oidc/deno.json apps/mock-oidc/deno.json
COPY apps/worker/deno.json apps/worker/deno.json
COPY apps/web/deno.json apps/web/package.json apps/web/
COPY packages/contracts/deno.json packages/contracts/deno.json
COPY packages/database/deno.json packages/database/deno.json
# Keep the resolved dependency cache in the image. Runtime containers are read-only
# and must never need network access or mutate workspace links during startup.
RUN deno install --frozen

FROM dependencies AS source
COPY apps ./apps
COPY packages ./packages

FROM source AS web-build
RUN deno task build

FROM source AS service-build
RUN deno compile --frozen -A --node-modules-dir=none --output /workspace/dg-chat-api apps/api/src/main.ts \
    && deno compile --unstable-worker-options --frozen -A --node-modules-dir=none \
      --include apps/worker/src/extraction-worker.ts \
      --output /workspace/dg-chat-worker apps/worker/src/main.ts

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY --from=web-build /workspace/apps/web/dist /usr/share/nginx/html
RUN <<'EOF'
cat > /etc/nginx/conf.d/default.conf <<'NGINX'
server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;
  client_max_body_size 100m;

  location ~ ^/(api|v1)/ {
    proxy_pass http://app:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }

  location ~ ^/(health|ready|metrics)$ {
    proxy_pass http://app:8000;
    proxy_set_header Host $host;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX
EOF
EXPOSE 8080

FROM debian:trixie-slim AS app
RUN set -eux; \
    installed=0; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /var/lib/apt/lists/*; \
      if apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
        && apt-get install -y --no-install-recommends ca-certificates curl; then \
        installed=1; \
        break; \
      fi; \
      sleep "$((attempt * 2))"; \
    done; \
    test "$installed" = 1; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system dgchat; \
    useradd --system --gid dgchat --no-create-home dgchat
COPY --from=service-build /workspace/dg-chat-api /usr/local/bin/dg-chat-api
ENV DENO_ENV=production \
    PORT=8000
EXPOSE 8000
USER dgchat
CMD ["/usr/local/bin/dg-chat-api"]

FROM debian:trixie-slim AS worker
RUN set -eux; \
    installed=0; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /var/lib/apt/lists/*; \
      if apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
        && apt-get install -y --no-install-recommends ca-certificates postgresql-client; then \
        installed=1; \
        break; \
      fi; \
      sleep "$((attempt * 2))"; \
    done; \
    test "$installed" = 1; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system dgchat; \
    useradd --system --gid dgchat --no-create-home dgchat
RUN <<'EOF'
cat > /usr/local/bin/worker-healthcheck <<'SCRIPT'
#!/bin/sh
set -eu
test "$(cat /proc/1/comm)" = "dg-chat-worker"
exec psql "$DATABASE_URL" --no-psqlrc --tuples-only --command "SELECT 1 FROM jobs LIMIT 0" >/dev/null
SCRIPT
chmod 0755 /usr/local/bin/worker-healthcheck
EOF
COPY --from=service-build /workspace/dg-chat-worker /usr/local/bin/dg-chat-worker
ENV DENO_ENV=production
USER dgchat
CMD ["/usr/local/bin/dg-chat-worker"]

FROM source AS development
USER deno
CMD ["task", "dev"]
