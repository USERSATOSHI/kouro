# `@kouro/harnesses` — Agent Harness and Artifact Writer Implementations

Infrastructure implementations of the normalized agent-harness and artifact
writer ports declared in `@kouro/executors`. Bridges Kouro's workflow
orchestration with provider agent runtimes and filesystem artifact storage.

## Architecture

```
Application layer (executors)
    ↓ declares port interfaces
AgentHarness | AgentHarnessRegistry | ArtifactWriter
    ↓
@kouro/harnesses (infrastructure implementations)
  ├── ClaudeCodeHarness — Claude Agent SDK
  ├── CodexHarness — speaks the `codex app-server` protocol
  ├── OpenCodeHarness — OpenCode SDK and supervised local server
  ├── PiHarness — in-process Pi AgentSession SDK
  ├── ScriptedFakeHarness — test double for scripted results
  ├── HarnessRegistry — in-memory harness registry
  ├── LocalArtifactWriter — filesystem artifact persistence
  ├── LocalInvocationActivityStore — cross-process best-effort live transcript observation
  └── BunProcessRunner — subprocess execution via Bun.spawn
```

## Agent Harnesses

### ClaudeCodeHarness

Runs Claude Code through Anthropic's Agent SDK:

```typescript
import { ClaudeCodeHarness } from '@kouro/harnesses';

const harness = new ClaudeCodeHarness();
```

**Execution model:**

- **`execute()`** starts a streaming SDK query and persists the provider's
  session ID as soon as it is reported.
- **`resume()`** passes the exact durable session ID back to the SDK.
- Pending Kouro steering is supplied as streaming user input; interruption
  calls the active query's native `interrupt()` control.
- `outputSchema` becomes the SDK's JSON-schema output format, and Kouro still
  validates the returned value independently.
- Read tools are always available. Write and command tools require the matching
  compiled capabilities.
- Project, user, and local settings are not loaded into the SDK query.
- Authorized workflow subagents are exposed through one Kouro-owned in-process
  MCP tool; provider-native delegation stays disabled.
- Effective workflow/run reasoning effort maps to the Claude Agent SDK `effort` option.

### CodexHarness

Runs OpenAI Codex through the local `codex app-server` JSON-RPC protocol:

```typescript
import { CodexHarness } from '@kouro/harnesses';

const harness = new CodexHarness();
```

**Execution model:**

- Starts one App Server process per active attempt and performs the required
  `initialize` / `initialized` handshake.
- **`execute()`** starts a thread; **`resume()`** resumes its exact durable
  thread ID.
- Starts a turn with the compiled model, output schema, working directory, and
  capability-derived `readOnly` or `workspaceWrite` sandbox policy.
- Maps durable Kouro steering and interrupt controls to `turn/steer` and
  `turn/interrupt`.
- Answers command and file-change approval requests from the workflow's
  compiled execute/write capabilities.
- Streams App Server notifications into the attempt transcript and parses the
  final agent message through Kouro's independent structured-output validator.
- Exposes authorized workflow subagents as a thread-scoped dynamic tool and
  answers tool calls through the normalized executor controller.
- Effective workflow/run reasoning effort maps to App Server `turn/start.effort`.

Kouro may call `resume()` for a later graph invocation of the same agent node,
not only for interruption recovery. The durable session token retains the
agent's engineering context; `clearContext: true` on the node forces
`execute()` instead.

The App Server sandbox restricts Codex's own tools. Kouro's worktree sandbox
and durable permission checks remain the outer isolation and authorization
boundary.

### OpenCodeHarness

Uses `@opencode-ai/sdk` to start a loopback-only OpenCode server for each active
attempt. A fresh execution creates a session in the worktree; resume opens the
exact durable session ID. Kouro maps steering to the SDK's `steer` delivery and
interruption to the session interrupt API. The generated `kouro` agent disables
ambient plugins, instructions, skills, task delegation, questions, and external
directory access. Its read, write, command, and network permissions come from
the compiled capabilities. The server and event subscription are always
disposed when the attempt ends.

When the workflow authorizes subagents, the generated plugin adds one custom
tool backed by an authenticated loopback bridge to the normalized executor
controller. The provider's native task delegation remains disabled.

Effective workflow/run reasoning effort maps to the selected OpenCode model variant.

The OpenCode SDK supervises the local `opencode` executable, so that executable
must still be installed and authenticated.

Every Bash tool call is rewritten through Kouro's cross-platform command
sandbox. Provider API traffic remains outside that boundary, while the command
receives only capability-derived worktree write and network access.

### PiHarness

Creates an in-process Pi `AgentSession` through
`@earendil-works/pi-coding-agent`. New durable tokens use the exact session JSONL
path; legacy Pi session IDs are resolved through the current project's session
index before resume. Kouro calls `session.steer()` and `session.abort()` for
live controls and disposes the session subscription afterward.

Kouro also registers Pi's built-in extensions when it creates the SDK runtime,
including the built-in `llama.cpp` provider. The built-in provider follows Pi's
normal configuration: set `LLAMA_BASE_URL` or run Pi's `/login llama.cpp`, and
load the model through Pi's llama.cpp model UI before selecting
`llama.cpp/<model-id>` in a workflow.
The `llamaServerUrl` setting and `llama-server=<url>` provider belong to the
separate `pi-llama-cpp` extension and do not configure this built-in provider.

Pi's tool allowlist is derived from declared capabilities: read tools are
always present, edit/write require a write capability, and Bash requires an
execute capability. Provider configuration and extensions remain available,
while skills, prompt templates, and themes are disabled. Schemas are included
in the normalized prompt and independently validated by Kouro.

Authorized workflow subagents are added as one in-process custom tool. The
child execution remains owned by Kouro and never receives that tool itself.

Effective workflow/run reasoning effort maps to Pi's `thinkingLevel`.

Pi replaces its built-in file and Bash tools with Kouro-owned tools. Direct
file operations use the exact-worktree path guard; Bash uses the same
cross-platform command sandbox as OpenCode.

### ScriptedFakeHarness

Test double that returns pre-scripted results:

```typescript
import { ScriptedFakeHarness, processFailure } from '@kouro/harnesses';
import { err } from '@usersatoshi/results';

const fake = new ScriptedFakeHarness('test-harness', [
  { output: { summary: 'done' }, transcript: '...' },  // First call succeeds
  err(processFailure('something broke')),                // Second call fails
  { output: { summary: 'retry' }, transcript: '...', resumeToken: 'abc' },  // Third call
]);

const result = await fake.execute(request);
console.log(fake.calls); // Inspect recorded calls for assertions
```

All recorded calls are stored in `fake.calls` as `RecordedHarnessCall[]` arrays.

## HarnessRegistry

In-memory registry mapping harness IDs to harness instances:

```typescript
import {
  ClaudeCodeHarness,
  CodexHarness,
  HarnessRegistry,
  OpenCodeHarness,
  PiHarness,
} from '@kouro/harnesses';

const registry = new HarnessRegistry([
  new ClaudeCodeHarness(),
  new CodexHarness(),
  new OpenCodeHarness(),
  new PiHarness(),
]);

const harness = registry.get('codex');
if (harness.isOk()) {
  // Use the harness
}
```

Validates uniqueness and non-empty IDs at construction time. Returns `HarnessErrorKind.Unavailable` for unknown harness IDs.

## LocalArtifactWriter

Persists artifacts to the local filesystem with checksum verification:

```typescript
import { LocalArtifactWriter } from '@kouro/harnesses';

const writer = new LocalArtifactWriter('/path/to/artifacts');

const result = await writer.write({
  runId: 'run-abc',
  invocationSequence: 1,
  attemptNumber: 1,
  kind: 'agent_output',
  mediaType: 'application/json',
  content: JSON.stringify({ result: 'success' }),
});
```

**Storage layout:**

```
<root>/<sha256(runId)>/<invocationSequence>/<attemptNumber>/<kind>.<ext>
```

| Kind | Extension |
|------|-----------|
| `agent_output` | `.json` |
| `command_output` | `.json` |
| `harness_transcript` | `.ndjson` |
| `git_diff` | `.diff` |
| `git_status` | `.txt` |

**Features:**
- Write-via-temp-file + atomic link pattern (prevents partial writes)
- Idempotent: if content matches existing file, succeeds; if different, fails with error
- Returns `ArtifactReference` with checksum (`sha256:...`), size, and a composite ID

## ProcessRunner

Port interface and Bun implementation for subprocess execution:

```typescript
import { BunProcessRunner } from '@kouro/harnesses';

const runner = new BunProcessRunner();
const result = await runner.run('claude', ['-p', 'hello'], '/tmp');
// Returns { exitCode: 0, stdout: '...', stderr: '' }
```

The runner can also copy decoded stdout chunks to an optional observer while
still returning the complete stdout transcript. The executor isolates observer
failures so presentation cannot alter attempt execution.

## Execution Flow

The typical flow through the harness system:

```
AgentExecutor.execute()  (from @kouro/executors)
  │
  ├── HarnessRegistry.get(harnessId) → AgentHarness
  │
  ├── selected AgentHarness.execute(request) or resume(request, token)
  │     │
  │     └── Provider SDK/App Server session
  │           ├── stream transcript and persist resume token
  │           ├── apply durable steering or interruption
  │           └── normalize final output → HarnessExecution
  │
  ├── validateStructuredOutput(output, schema)
  │
  └── LocalArtifactWriter.write(request) × 2 (transcript + output)
        │
        └── Atomic filesystem write → ArtifactReference
```

When `HarnessExecutionRequest.model` is set, each adapter passes an explicit
model to its provider runtime:

- Claude Agent SDK: `<model>`
- Codex App Server: `<model>`
- OpenCode SDK: `<provider>/<model>`
- Pi SDK: `<provider>/<model>` or a unique model ID

The same selection is used for fresh and resumed execution. When `model` is
omitted, the adapter leaves model selection to the provider runtime.

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `ClaudeCodeHarness` | class | `claude-code-harness.ts` |
| `CodexHarness` | class | `codex-harness.ts` |
| `OpenCodeHarness` | class | `opencode-harness.ts` |
| `PiHarness` | class | `pi-harness.ts` |
| `ClaudeAgentSdk`, `ClaudeSdkQuery` | interfaces | `claude-code-harness.ts` |
| `OpenCodeAgentSdk`, `OpenCodeSdkSession` | interfaces | `opencode-harness.ts` |
| `PiAgentSdk`, `PiSdkSession` | interfaces | `pi-harness.ts` |
| `ScriptedFakeHarness` | class | `scripted-fake-harness.ts` |
| `HarnessRegistry` | class | `registry.ts` |
| `LocalArtifactWriter` | class | `local-artifact-writer.ts` |
| `BunProcessRunner` | class | `process-runner.ts` |
| `ProcessOutput` | interface | `process-runner.ts` |
| `ProcessRunner` | interface | `process-runner.ts` |
| `ScriptedHarnessResult` | type | `scripted-fake-harness.ts` |
| `RecordedHarnessCall` | interface | `scripted-fake-harness.ts` |
| `processFailure`, `invalidResponse` | functions | `errors.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/executors` | Port interfaces (`AgentHarness`, `HarnessRegistry`, etc.) |
| `@kouro/domain` | `ArtifactReference` type |
| `@usersatoshi/results` | `Result<T, E>` type |
| `@anthropic-ai/claude-agent-sdk` | Claude streaming session and controls |
| `@anthropic-ai/sdk` | Claude Agent SDK peer dependency |
| `@opencode-ai/sdk` | OpenCode server/client and session controls |
| `@earendil-works/pi-coding-agent` | In-process Pi agent sessions |
