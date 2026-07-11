# DG Chat

DG Chat is a self-hosted, OpenAI-compatible chat platform with immutable conversation branching,
approval-based accounts, usage-based credits, provider routing, personal API tokens, and an
integrated administration console.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for local setup and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system design.

Durable document embeddings are an explicit deployment opt-in. Configure both
`DOCUMENT_EMBEDDING_MODEL_ID` and `DOCUMENT_EMBEDDING_CONFIG_VERSION` on the worker; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for keyring, Redis, and lease requirements.
