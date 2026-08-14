# `@kouro/web` — Ticket and Execution Dashboard

Kouro's local ticket and execution dashboard, built with **React 19**, **Vite**,
and **React Flow** (`@xyflow/react`). It displays a unified planning/execution
Kanban, ticket histories and redacted provider configuration alongside runs,
workflow graphs, durable events, artifacts, diffs, and artifact-bound approval
controls. Active agent attempts expose a best-effort coding-agent session where
provider streams are presented as user, agent, reasoning, and call-ID-correlated
tool exchanges above in-context steering and stop controls.

## Design Constraints

- **Durable operator controls** — Pause, resume, cancel, steer, interrupt, retry, and policy-authorized skip call application endpoints with idempotency keys; the browser never mutates run state locally
- **Read-only workflow graph** — Operator actions do not edit graph structure (`nodesConnectable={false}`, `nodesDraggable={false}`)
- **Repository-scoped runs** — The serving application enforces the repository boundary before data reaches React
- **Explicit terminal deletion** — A confirmed delete removes only terminal runs and Kouro-owned local data
- **The browser cannot supply an approval binding** — Approvals are submitted by a human operator ("web-user") but cryptographic/state bindings happen server-side
- **Live event replay** — Events are delivered via Server-Sent Events (SSE) with `lastEventId` tracking for resilient reconnection
- **Live invocation activity** — Active harness stdout is polled through an ephemeral observation endpoint without changing durable orchestration history
- **Coding-agent session** — The live transcript modal keeps user prompts, agent messages, reasoning, tool calls, and results beside a sticky steering composer with send and stop controls
- **Editor-style artifact preview** — Code, JSON, diffs, and command output use line numbers, language labels, and syntax-aware highlighting
- **Review workspace** — Delivery approvals combine a changed-file navigator, editor-style bound diff, editable commit/PR metadata, and prominent decision controls
- **Resizable inspector** — The execution inspector is a persistent bottom drawer that supports pointer dragging and keyboard resizing
- **Markdown tool activity** — Structured tool arguments and results become readable Markdown fields, while shell commands and fenced code retain syntax highlighting
- **Prompt deduplication** — The invocation prompt is added only when the provider transcript did not already emit the same user message
- **Switchable workflow layout** — Operators can use a layered top-to-bottom or left-to-right flowchart, or a compact network graph
- **Derived ticket columns** — The API supplies planning and runtime-owned execution projections; React never persists board state
- **Markdown ticket details** — Ticket descriptions and comments render headings, lists, links, quotes, inline code, and fenced code without accepting raw HTML
- **Ticket-scoped workflow launch** — Ticket details launch a workflow against a selected repository with immutable ticket input, optional base-branch and harness routing, and direct navigation to the created run
- **Portable reasoning effort** — Ticket launch can snapshot a provider-default, low, medium, or high fallback while compiled agent and subagent settings take precedence
- **Nested subagent sessions** — Active and completed Kouro subagents render as separate live sessions with delegated task, harness/model/effort metadata, reasoning, tool activity, and structured output instead of embedded JSONL
- **Delegation-aware diagrams** — Flow and graph views show declared child roles with dashed parent edges; timeline lanes show each recorded child call at its parent activation tick
- **Visible usage attribution** — Workflow and subagent blocks display token usage and derived cost directly, while unpriced models fail closed to an `unpriced` label
- **Read-only run comparison** — Operators can select two to four durable runs and compare status, inputs, duration, invocations, attempts, subagent calls, tokens, estimated cost, and per-role attribution without creating evaluation state or inferring a winner
- **Approval proposal context** — Generic approvals include the exact source invocation output, so a plan can be reviewed without leaving the approval workspace
- **Server-resolved provider secrets** — Provider configuration responses contain status and non-secret scope only

## Quick Start

```bash
# Development (with HMR, proxying /api to localhost:3000)
bun run dev

# Production build
bun run build
```

Output goes to `dist/` (static files served by the Kouro CLI's `serve` command or any HTTP server).

## Architecture

```
App (root component)
├── RunList (sidebar)
│   ├── All runs with status badges
│   └── Multi-run comparison selection
└── Workspace (main area)
    ├── Error banner (conditional)
    ├── Run Header
    │   └── Workflow ID, run ID, pause/resume/cancel, status, event count
    ├── Graph (React Flow)
    │   └── Top-to-bottom flowchart with topology layers, typed shapes, outcomes, and selected-path emphasis
    └── Inspector (tabbed panel)
        ├── "control" tab → OperatorConsole
        │   └── Exact invocation selection, agent-session launcher, interrupt, retry, and declared skip
        ├── "details" tab → NodeDetails
        │   └── Node definition + invocations + attempts
        ├── "events" tab → EventLog
        │   └── SSE-driven durable replayed events
        ├── "artifacts" tab → Artifacts
        │   └── Artifact list + content viewer
        └── "approval" tab → ApprovalControl
            └── Grant/reject with reason
    └── IDE status bar
        └── Repository, workflow checksum, invocation count, and approval count
    └── Agent session / artifact / comparison modal
        ├── Full-size readable transcript with call-ID-correlated tool results and in-context steering
        └── Side-by-side durable metrics with experiment-compatibility warnings
```

## Data Flow

1. **Mount** → `fetchRuns()` populates the run list sidebar
2. **Run selection** → `fetchRun()`, `fetchArtifacts()`, `fetchApprovals()` in parallel
3. **SSE stream** → `reconnectEvents()` opens an `EventSource` for live durable events
4. **Event deduplication** → Incoming events are deduplicated by `id` before appending to the event log
5. **Node click** → Inspector switches to "details" tab showing that node's invocations/attempts
6. **Artifact click** → Content fetched on demand via `fetchArtifact()`
7. **Approval action** → `decideApproval()` POSTs grant/reject; on success, run state and approvals are re-fetched
8. **Active attempt** → `fetchInvocationActivity()` polls the worker's best-effort transcript while the durable attempt remains active
9. **Run control** → `controlRun()` persists pause, resume, or cancel and refreshes the complete execution read model
10. **Invocation control** → The Control tab opens the exact agent session; its transcript-adjacent composer and stop action call `controlInvocation()`, while retry and skip remain in the recovery surface
11. **Ticket launch** → Repository selection and ticket identity are submitted to `createRun()`; the server durably snapshots and links the ticket, returns the new run immediately, and lets the local worker continue execution while the UI opens its execution view

## API Client

The `api.ts` module provides:

```typescript
import {
  createRun,
  fetchRuns,
  fetchRepositories,
  fetchRun,
  fetchApprovals,
  fetchArtifacts,
  fetchArtifact,
  controlRun,
  controlInvocation,
  decideApproval,
  reconnectEvents,
} from '@kouro/web/api';

const [repository] = await fetchRepositories();
if (repository) {
  await createRun({
    adw: 'feature-development',
    repositoryPath: repository.path,
    ticket: 'kouro:ticket-abc',
    reasoningEffort: 'high',
    actor: 'web-user',
  });
}

// List all runs
const runs = await fetchRuns();

// Get run details
const details = await fetchRun('run-abc');

await controlRun('run-abc', 'pause', {
  actor: 'web-user',
  idempotencyKey: 'web:pause:1',
});

await controlInvocation('run-abc', 3, 'steer', {
  actor: 'web-user',
  message: 'Preserve the public API and continue.',
  idempotencyKey: 'web:steer:1',
});

// SSE event stream
const close = reconnectEvents('run-abc', lastEventId, (event) => {
  console.log(event.type, event.data);
});
// Call close() to disconnect
```

### SSE Events

`reconnectEvents` listens for both generic `message` events and 20 named event types covering the full Kouro lifecycle:

- Run lifecycle: `run.created`, `run.paused`, `run.resumed`, `run.cancelled`, `run.completed`
- Invocation lifecycle: `invocation.activated`, `invocation.completed`, `invocation.skipped`, `invocation.retry_requested`
- Attempt lifecycle: `attempt.started`, `attempt.resumed`, `attempt.resume_token_recorded`, `attempt.artifact_published`, `attempt.failed`, `attempt.interrupted`, `attempt.interrupt_requested`, `agent.steering_requested`, `agent.steering_applied`, `agent.steering_rejected`
- Artifacts: `run.artifact_published`
- Approval: `approval.requested`, `approval.granted`, `approval.rejected`

### Runtime Validation

Each API response is validated through runtime type guards (`isRunSummary`, `isRunDetails`, `isApprovalView`, `isArtifactView`). On validation failure, an `Error` is thrown with a descriptive message.

## Visual Design

GitHub-inspired dark theme with compact developer typography, familiar borders,
status pills, code surfaces, and color-coded state indicators:

| State | Color |
|-------|-------|
| `succeeded` | Green |
| `failed` / `rejected` | Red |
| `running` / `active` | Blue |
| `waiting_for_approval` | Amber |
| `pending` | Gray |
| `interrupted` / `cancelled` | Orange |

On wide screens, runs use an IDE-style repository explorer, flexible workflow
canvas, resizable control/inspection drawer, and compact status bar. Tickets use
a horizontally scrollable project board beside an independently scrolling
detail and durable-history workspace. Each ticket column scrolls vertically so
large backlogs do not push the selected ticket out of view. Tablet and mobile
layouts stack the bounded-height board above ticket details, use touch-safe
horizontal run and ticket selectors, and provide full-screen transcript and
artifact inspectors.

Node positions derive from graph reachability rather than declaration index, so
branches share a layer and bounded loop edges route back to earlier layers.
The diagram toolbar stores its flowchart/graph and direction choices as
device-local preferences. Parallel outgoing transition labels receive separate
offsets so their outcome titles remain readable.

## Vite Dev Proxy

The dev server proxies `/api/*` to `http://localhost:3000` (the Kouro CLI serve command). The `/api` prefix is stripped before forwarding:

```typescript
// vite.config.ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:3000',
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
},
```

## Build and Deployment

```bash
# Build
bun run build

# Output:
# dist/index.html
# dist/assets/index-<hash>.css
# dist/assets/index-<hash>.js

# Serve via Kouro CLI
bun run kouro serve
```

The Kouro CLI (`kouro serve`) serves the production build from its own HTTP server with SPA fallback (all routes not matching `/api/*` serve `index.html`).

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@kouro/api-contracts` | workspace:* | TypeScript interfaces for API shapes |
| `@xyflow/react` | ^12.11.2 | React Flow DAG graph rendering |
| `react` | ^19.2.8 | UI framework |
| `react-dom` | ^19.2.8 | React DOM renderer |

## Dev Dependencies

| Dependency | Purpose |
|------------|---------|
| `@types/react`, `@types/react-dom` | TypeScript types |
| `@vitejs/plugin-react` | Vite React plugin |
| `vite` | Build tool and dev server |
