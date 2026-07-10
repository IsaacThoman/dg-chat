const url = Deno.args[0] ?? "http://localhost:8000/ready";
const timeoutMs = Number(Deno.args[1] ?? "120000");
const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      console.log(`${url} is ready`);
      Deno.exit(0);
    }
  } catch {
    // The service may not have bound its socket yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.error(`${url} did not become ready within ${timeoutMs}ms`);
Deno.exit(1);
