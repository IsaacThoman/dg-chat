import type { Conversation, Message, Model, Token, User } from "./types.ts";

export const demoUser: User = {
  id: "u_1",
  name: "Isaac",
  email: "isaac@example.com",
  role: "admin",
  status: "approved",
  balance: 4.82,
};
export const demoConversations: Conversation[] = [
  {
    id: "1",
    title: "Designing the knowledge system",
    preview: "A robust ingestion pipeline…",
    updatedAt: "Now",
    pinned: true,
    project: "DG Chat",
  },
  {
    id: "2",
    title: "Postgres query optimization",
    preview: "The index scan is the likely…",
    updatedAt: "2h",
    pinned: true,
  },
  {
    id: "3",
    title: "Weekend trip ideas",
    preview: "Given the weather in…",
    updatedAt: "Yesterday",
  },
  {
    id: "4",
    title: "Explain circuit breakers",
    preview: "A circuit breaker protects…",
    updatedAt: "Mon",
  },
  {
    id: "5",
    title: "API compatibility audit",
    preview: "The Responses API requires…",
    updatedAt: "Jul 2",
    archived: true,
  },
];
export const demoMessages: Message[] = [
  {
    id: "m1",
    role: "user",
    content:
      "Help me design a **reliable knowledge ingestion system** for PDFs and images. It should preserve citations and survive retries.",
    createdAt: "10:31 AM",
    attachments: [{ name: "architecture-notes.pdf", type: "PDF", size: "1.8 MB" }],
  },
  {
    id: "m2",
    role: "assistant",
    model: "Claude Sonnet 4",
    latency: "2.4s · 786 tokens",
    createdAt: "10:31 AM",
    content:
      'A reliable ingestion system works best as a small state machine rather than one long job. The key is making every transition **idempotent**.\n\n### Recommended pipeline\n\n1. **Ingest** — stream the object to S3-compatible storage, calculate its content hash, and write the attachment record.\n2. **Inspect** — sniff the real MIME type, enforce size and pixel limits, and quarantine anything suspicious.\n3. **Extract** — use a format-specific parser. Preserve page numbers and bounding boxes as source metadata.\n4. **Chunk & embed** — create deterministic chunk IDs from `(document, version, page, position)`.\n5. **Publish** — atomically swap the active document version only after every chunk is ready.\n\n```ts\nconst chunkId = hash(`${documentId}:${version}:${page}:${offset}`)\nawait jobs.enqueue({ key: chunkId, kind: "embed" })\n```\n\nThis makes retries safe: duplicate jobs converge on the same records instead of creating duplicate chunks.',
    branch: { index: 1, total: 2, labels: ["Original response", "More concise"] },
  },
  {
    id: "m3",
    role: "user",
    content:
      "How should edits work if a user changes the original request later? I never want history to be destroyed.",
    createdAt: "10:34 AM",
    branch: { index: 2, total: 3, labels: ["Original", "Added retry constraint", "Current edit"] },
  },
  {
    id: "m4",
    role: "assistant",
    model: "GPT-4.1",
    latency: "1.7s · 421 tokens",
    createdAt: "10:34 AM",
    content:
      "Treat each edit as a new node in an **immutable conversation graph**. The edited message becomes a sibling of the prior message, and the new response grows from that sibling.\n\nUsers can move between alternatives with the arrows beneath the message, while a tree view exposes the full history. Nothing is overwritten: even attachment links and generation metadata remain attached to the original node.",
    branch: { index: 3, total: 3, labels: ["First answer", "With example", "Current answer"] },
  },
];
export const demoModels: Model[] = [
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    provider: "OpenAI",
    context: "1M",
    capabilities: ["Vision", "Tools"],
    healthy: true,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "OpenRouter",
    context: "200K",
    capabilities: ["Vision", "Reasoning"],
    healthy: true,
  },
  {
    id: "local/qwen3",
    name: "Qwen 3 32B",
    provider: "Local",
    context: "128K",
    capabilities: ["Tools"],
    healthy: false,
  },
];
export const demoTokens: Token[] = [
  {
    id: "t1",
    name: "Local scripts",
    preview: "dg_sk_••••8FA2",
    scopes: ["chat", "models"],
    createdAt: "Jun 28, 2026",
    lastUsed: "12 minutes ago",
  },
  {
    id: "t2",
    name: "Raycast",
    preview: "dg_sk_••••19BC",
    scopes: ["chat"],
    createdAt: "Jul 3, 2026",
    expires: "Oct 3, 2026",
  },
];
