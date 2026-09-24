# Local workflow use

The editable `feature` starter takes a task, asks for plan approval, runs the
implementer with workspace write access, then runs `bun run typecheck` and
`bun test`. Edit these command nodes for a project's scripts.

Run it with `codex-workspace-write` or `claude-workspace-write` to grant file
write access only to roles that explicitly declare
`workspaceAccess: "workspace-write"`. The planner stays read-only. The
corresponding `*-readonly` profile stays read-only for every role. Claude runs
through the Claude Agent SDK and uses the SDK's supported local authentication;
Kouro does not require an API-key-only setup.

The starter's Bun validation commands are marked
`executionMode: "trusted-unrestricted"` because local Bun/npm installations
and their child tools vary by machine. Starting this workflow requires the
separate `allowUnrestrictedCommands` launch option (CLI:
`--allow-unrestricted-commands`; web: “Allow unrestricted commands”). This
choice is recorded with command evidence. Choose it only for a workflow and
workspace whose commands you trust.

The starter does not declare native scouts. Codex and Pi adapters do not yet
provide the awaited, read-only same-turn child call required by Kouro's scout
contract, so adding scouts would prevent the planner from running. The
repository-scout and test-scout prompt/schema assets remain available for a
future adapter that implements that contract; this starter does not claim v1
scout parity.
