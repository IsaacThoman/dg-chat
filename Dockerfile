# syntax=docker/dockerfile:1.7

FROM denoland/deno:alpine AS dependencies
WORKDIR /workspace
ENV DENO_DIR=/deno-dir
COPY deno.json package.json ./
COPY apps ./apps
COPY packages ./packages
# Keep the resolved dependency cache in the image. Runtime containers are read-only
# and must never need network access or mutate workspace links during startup.
RUN deno install --frozen=false

FROM dependencies AS web-build
RUN deno task build

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

FROM dependencies AS app
COPY --from=web-build /workspace/apps/web/dist ./apps/web/dist
ENV DENO_ENV=production \
    PORT=8000
EXPOSE 8000
USER deno
CMD ["task", "--filter", "@dg-chat/api", "start"]

FROM dependencies AS worker
ENV DENO_ENV=production
USER deno
CMD ["task", "--filter", "@dg-chat/worker", "start"]

FROM dependencies AS development
USER deno
CMD ["task", "dev"]
