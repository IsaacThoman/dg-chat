import { assertStringIncludes } from "jsr:@std/assert@1.0.14";

Deno.test("production web boundary redacts share capabilities before access logging", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../../../Dockerfile", import.meta.url));
  assertStringIncludes(dockerfile, "~^/share/ /share/[REDACTED]");
  assertStringIncludes(dockerfile, "~^/api/public/shares/ /api/public/shares/[REDACTED]");
  assertStringIncludes(dockerfile, "access_log /dev/stdout dgchat_privacy");
  assertStringIncludes(dockerfile, 'add_header Referrer-Policy "no-referrer" always');
});

Deno.test("the static document blocks capability referrers before application startup", async () => {
  const html = await Deno.readTextFile(new URL("../../web/index.html", import.meta.url));
  assertStringIncludes(html, '<meta name="referrer" content="no-referrer" />');
});
