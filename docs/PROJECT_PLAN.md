# DG Chat Product Goal and Completion Plan

Last updated: 2026-07-21

## Overarching goal

Deliver a production-ready, self-hostable ChatGPT-style platform as a TypeScript/Deno monorepo. The
product combines immutable, branch-preserving chat; resilient OpenAI-compatible provider routing;
user approval, tokens, and credit accounting; uploads, knowledge retrieval, tools, voice, and
images; administration and analytics; and a secure Docker Compose deployment.

The web application must be polished, accessible, responsive, and installable as a PWA. There is no
native mobile application. Conversations are private by default. Live collaborative editing,
Assistants, batches, fine-tuning, and realtime API compatibility remain intentionally out of scope.

## Recovered project status

The original multi-day Codex build task ran on `Isaacs-iMac.local`. Its task service was unavailable
when work resumed on 2026-07-21, so the exact task transcript could not be read. The authoritative
original plan was recovered from the related planning task, and the repository/GitHub state provides
the durable implementation handoff.

- `main` currently includes merged work through PR #30 (`7dd7e91`).
- Draft PR #31, `codex/chat-session-continuity`, contains the latest 34-commit continuation.
- PR #31 reports 373 web tests, 892 non-PostgreSQL Deno tests, a production PWA build, and focused
  PostgreSQL verification before its final push.
- Its last CI run passed security, SBOM/image scanning, container builds, Redis integration, backup
  roundtrips, load invariants, and production Compose startup.
- Two inherited failures remain: Deno lint errors in `Community.tsx` and one PostgreSQL worker
  fixture cleanup failure. Their downstream official-SDK and Playwright jobs were skipped.
- A shadcn migration has not started. The requested preset `b6ZjldV0i` resolves to Mira style, mauve
  theme/base/chart colors, small radius, Oxanium font, Remix icons, and subtle default menus.

## Completion roadmap

### 1. Stabilize the inherited branch

- Fix both PR #31 failures at their root cause.
- Run formatting, lint, type checks, unit tests, PostgreSQL integration, production build, container
  smoke tests, official OpenAI client contracts, and browser journeys.
- Merge or supersede PR #31 only after its required checks are green.

### 2. Adopt the requested shadcn system

- Initialize shadcn in the existing Vite application with preset `b6ZjldV0i`.
- Preserve the existing product information architecture and behavior while moving shared primitives
  to accessible shadcn components and preset tokens.
- Migrate foundational controls first: buttons, inputs, textareas, dialogs/sheets, menus, tabs,
  tooltips, cards, badges, tables, alerts, and form states.
- Apply the preset consistently across chat, account, administration, analytics, and public-share
  surfaces without leaving a split visual system.
- Verify dark/light themes, keyboard/focus behavior, reduced motion, narrow screens, and PWA/offline
  states. Update visual baselines intentionally.

### 3. Close documented product and operations gaps

- Re-audit the implementation against the original milestones and this repository's documentation.
- Resolve release-relevant gaps in Redis coordination, attachment inspection and retention, object
  garbage collection, observability/alerts, backup/restore validation, secret rotation, deployment,
  and user-facing workflows.
- Keep explicitly excluded product areas excluded unless they are necessary for a promised workflow.

### 4. Final verification and release handoff

- Exercise fresh and upgrade migrations against isolated PostgreSQL databases.
- Validate the full Docker Compose topology, health/readiness, graceful restart, multi-replica
  safety, backup/restore, storage, Redis, and worker recovery.
- Run official JavaScript and Python OpenAI client contracts.
- Run Playwright desktop, mobile, accessibility, keyboard, and visual journeys and perform manual
  browser inspection of the highest-risk flows.
- Re-run dependency, secret, filesystem, SBOM, and image vulnerability checks.
- Ensure documentation, environment examples, and operator runbooks match verified behavior.

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
6. The project docs record supported behavior, intentional exclusions, residual operational risks,
   and exact verification evidence.
7. All completion work is committed and pushed in reviewable milestones; unrelated local files are
   never included.

Software can always be extended, so "no possible improvements" is operationalized here as no known
missing in-scope feature, unresolved defect, failing required gate, undocumented release risk, or
unreviewed placeholder at handoff.
