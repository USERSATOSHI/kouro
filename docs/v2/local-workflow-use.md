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

The feature starter declares a required `repositoryScout` and an optional
`testScout`. The planner invokes them as bounded `subagent` tool calls and gets
each typed result in the same turn. The implementer receives the reports from
the accepted planner attempt. Child agents use read-only tools and cannot run
commands, edit files, or start nested subagents.

Codex uses a run-scoped MCP server, Pi loads a run-scoped extension, and Claude
uses an in-process MCP server from the Claude Agent SDK. Real provider use still
requires the corresponding harness to be installed and authenticated. The local
test suite exercises the MCP and extension bridges; it does not make a live
provider call.
