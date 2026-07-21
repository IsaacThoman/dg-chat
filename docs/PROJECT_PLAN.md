# DG Chat Product Goal and Completion Plan

Last updated: 2026-07-21

## Overarching goal

Deliver a production-ready, self-hostable ChatGPT-style platform as a TypeScript/Deno monorepo. The
product combines immutable, branch-preserving chat; resilient OpenAI-compatible provider routing;
user approval, tokens, and credit accounting; uploads, knowledge retrieval, tools, voice, and
images; administration and analytics; and a secure Docker Compose deployment.

The web application must be polished, accessible, responsive, and installable as a PWA. There is no
native mobile application. Conversations are private by default. Live collaborative editing,
Assistants, batches, and fine-tuning remain intentionally out of scope. OpenAI Realtime API
compatibility is required, including production-ready WebSocket and browser WebRTC transports,
Realtime conversation and transcription sessions, bidirectional client/server events, audio,
interruptions, tools, accounting, authorization, and distributed lifecycle handling.

## Recovered project status

The original multi-day Codex build task ran on `Isaacs-iMac.local`. Its task service was unavailable
when work resumed on 2026-07-21, so the exact task transcript could not be read. The authoritative
original plan was recovered from the related planning task, and the repository/GitHub state provides
the durable implementation handoff.

- `main` currently includes merged work through PR #30 (`7dd7e91`).
- Draft PR #31, `codex/chat-session-continuity`, is the active continuation and now includes the
  recovered completion work.
- Final verification covers 428 web tests, 1,020 non-PostgreSQL Deno tests, isolated PostgreSQL and
  Redis integration suites, 228 browser journeys, type/lint/format gates, and a production PWA
  build.
- The inherited lint and storage-cleanup failures are fixed. A later PostgreSQL CI run exposed stale
  attachment-inspection fixtures and an unclassified repository timeout; both are fixed and covered
  by the spawned-worker shutdown/recovery tests.
- The shadcn migration is initialized. Preset `b6ZjldV0i` supplies Mira style, mauve semantic
  tokens, small radius, Oxanium, Remix icons, and subtle default menus. Foundational primitives are
  installed, theme-token collisions are isolated from legacy variables, and authentication/bootstrap
  surfaces now use shadcn Card, Button, Input, and TooltipProvider primitives.

## Completion roadmap

### 1. Stabilize the inherited branch — completed

- Fix both PR #31 failures at their root cause.
- Run formatting, lint, type checks, unit tests, PostgreSQL integration, production build, container
  smoke tests, official OpenAI client contracts, and browser journeys.
- Merge or supersede PR #31 only after its required checks are green.

### 2. Adopt the requested shadcn system — completed

- Initialize shadcn in the existing Vite application with preset `b6ZjldV0i`.
- Preserve the existing product information architecture and behavior while moving shared primitives
  to accessible shadcn components and preset tokens.
- Migrate foundational controls first: buttons, inputs, textareas, dialogs/sheets, menus, tabs,
  tooltips, cards, badges, tables, alerts, and form states.
- Apply the preset consistently across chat, account, administration, analytics, and public-share
  surfaces without leaving a split visual system.
- Verify dark/light themes, keyboard/focus behavior, reduced motion, narrow screens, and PWA/offline
  states. Update visual baselines intentionally.

### 3. Close documented product and operations gaps — completed

- Re-audit the implementation against the original milestones and this repository's documentation.
- Resolve release-relevant gaps in Redis coordination, attachment inspection and retention, object
  garbage collection, observability/alerts, backup/restore validation, secret rotation, deployment,
  and user-facing workflows.
- Keep explicitly excluded product areas excluded unless they are necessary for a promised workflow.

### 4. Final verification and release handoff — completed

- Exercise fresh and upgrade migrations against isolated PostgreSQL databases.
- Validate the full Docker Compose topology, health/readiness, graceful restart, multi-replica
  safety, backup/restore, storage, Redis, and worker recovery.
- Run official JavaScript and Python OpenAI client contracts.
- Run Playwright desktop, mobile, accessibility, keyboard, and visual journeys and perform manual
  browser inspection of the highest-risk flows.
- Re-run dependency, secret, filesystem, SBOM, and image vulnerability checks.
- Ensure documentation, environment examples, and operator runbooks match verified behavior.

### 5. OpenAI Realtime API compatibility — active

- Expose the current GA `/v1/realtime` WebSocket event protocol for trusted server clients and media
  pipelines, authenticated with owner-scoped DG Chat personal API tokens.
- Expose the current GA `/v1/realtime/calls` WebRTC session-establishment flow for browser clients,
  without disclosing provider credentials, and support a server sideband control connection.
- Implement Realtime conversation and transcription session types, text/audio input, streamed
  text/audio/transcript output, VAD and push-to-talk, interruption/cancellation/truncation, tools,
  session updates, conversation-item lifecycle, and structured protocol errors.
- Route only to entitled, enabled, explicitly priced Realtime-capable registry models. Apply the
  existing provider fallback, circuit-breaker, credit reservation/settlement, rate-limit, audit,
  safety-identifier, and tenancy boundaries without silently degrading unsupported events.
- Add bounded session lifetime, message/audio/event sizes, backpressure, idle timeouts, disconnect
  cleanup, multi-replica coordination, graceful shutdown, observability, and privacy-safe logs.
- Verify protocol behavior with official event schemas and SDK/client flows, isolated integration
  tests, adversarial tests, bounded load, WebRTC browser journeys, and fresh/upgrade Compose runs.

## Prior completion record and exact evidence

PR #31 completed roadmap items 1–4 on 2026-07-21. The release-candidate source revision is
`7d1c5d3`. The retained-chat architecture now preserves bounded chat sessions, drafts, uploads,
immutable edits, streams, prompt queues, voice resources, media preferences, and one-time share
links across all workspace routes. Worker recovery, database timeout handling, attachment claims,
container builds, and current GitHub Actions runtimes were also hardened. The requested shadcn
preset `b6ZjldV0i` is the documented and installed design-system foundation.

Exact GitHub evidence for that revision:

- [CI run 29811243316](https://github.com/IsaacThoman/dg-chat/actions/runs/29811243316) passed
  format, lint, types, 1,020 Deno tests, 428 web tests, the production build, all three container
  builds, isolated PostgreSQL/concurrency, Redis, PostgreSQL/S3 backup roundtrip, production Compose
  startup/restart/observability, and official JavaScript/Python OpenAI SDK contracts.
- The same CI run scheduled 228 browser journeys: desktop Chromium passed 112 with two intentional
  project exclusions, while mobile Chromium passed all 114. These cover accessibility, visual
  baselines, keyboard behavior, responsive layouts, PWA upgrades, authentication, administration,
  chat continuity, media, knowledge, tools, sharing, recovery, and portability.
- [Security run 29811243300](https://github.com/IsaacThoman/dg-chat/actions/runs/29811243300) passed
  secret, dependency, filesystem, image, SBOM, and CodeQL checks.
- [Bounded load run 29811243138](https://github.com/IsaacThoman/dg-chat/actions/runs/29811243138)
  passed the multi-replica concurrency, rate-limit, accounting, and recovery invariants.

Fresh local production Compose verification independently reproduced the hosted Knowledge failure
and proved its corrected desktop and mobile journeys before the final source revision was pushed.
That handoff's completeness claim applied to the earlier scope and was superseded when Realtime API
compatibility became required on 2026-07-21. The overarching goal is active until roadmap item 5 and
its revised release gates are complete.

## Definition of done

The application is complete for the agreed scope when:

1. Every promised in-scope workflow is implemented end to end with no known release-blocking defect.
2. Required local and GitHub quality gates pass from a reproducible checkout.
3. Fresh self-hosted deployment and upgrade, backup, restore, shutdown, and recovery paths are
   proven.
4. Desktop and mobile browser journeys are accessible, visually coherent, and free of known broken
   or placeholder states.
5. Security boundaries for auth, credits, uploads, secrets, tools, network access, and tenancy have
   automated adversarial coverage.
6. Realtime WebSocket and WebRTC clients pass the documented GA event lifecycle, audio,
   transcription, interruption, tool, reconnect, accounting, and multi-replica safety contracts.
7. The project docs record supported behavior, intentional exclusions, residual operational risks,
   and exact verification evidence.
8. All completion work is committed and pushed in reviewable milestones; unrelated local files are
   never included.

Software can always be extended, so "no possible improvements" is operationalized here as no known
missing in-scope feature, unresolved defect, failing required gate, undocumented release risk, or
unreviewed placeholder at handoff.
