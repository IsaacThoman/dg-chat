import { assert, assertStringIncludes } from "jsr:@std/assert@1.0.14";

Deno.test("production web boundary redacts share capabilities before access logging", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../../../Dockerfile", import.meta.url));
  assertStringIncludes(dockerfile, "~^/share/ /share/[REDACTED]");
  assertStringIncludes(dockerfile, "~^/api/public/shares/ /api/public/shares/[REDACTED]");
  assertStringIncludes(dockerfile, "access_log /dev/stdout dgchat_privacy");
  assertStringIncludes(dockerfile, "~^/api/ /api/[ROUTE]");
  assertStringIncludes(dockerfile, "~^/v1/ /v1/[ROUTE]");
  assertStringIncludes(dockerfile, "~^/chat/ /chat/[ROUTE]");
  assertStringIncludes(dockerfile, "~^/admin/ /admin/[ROUTE]");
  const mapStart = dockerfile.indexOf("map $request_uri $dgchat_safe_request_uri {");
  const mapEnd = dockerfile.indexOf("\n}\n\nlog_format dgchat_privacy", mapStart);
  const publicShareRule = dockerfile.indexOf("~^/api/public/shares/", mapStart);
  const genericApiRule = dockerfile.indexOf("~^/api/ /api/[ROUTE]", mapStart);
  assert(mapStart >= 0 && mapEnd > mapStart);
  assert(publicShareRule > mapStart && publicShareRule < genericApiRule && genericApiRule < mapEnd);
  assertStringIncludes(dockerfile, 'add_header Referrer-Policy "no-referrer" always');
});

Deno.test("the static document blocks capability referrers before application startup", async () => {
  const html = await Deno.readTextFile(new URL("../../web/index.html", import.meta.url));
  assertStringIncludes(html, '<meta name="referrer" content="no-referrer" />');
});
