# Local workflow use

The editable `feature` starter takes a task, asks for plan approval, runs the
implementer with workspace write access, then runs `bun run typecheck` and
`bun test`. Edit these command nodes for a project's scripts.

Run it with `codex-workspace-write` or `claude-workspace-write` to allow writes
only for roles that declare `repository.write`; the planner declares only
`repository.read`. The run profile selects the default harness; explicit node
capabilities control each agent's permissions.
Claude runs through the Claude Agent SDK and uses the SDK's supported local
authentication; Kouro does not require an API-key-only setup.

The starter's Bun validation commands declare `terminal.execute`. This is an
explicit workflow-author grant for those command nodes and avoids a second
launch-time opt-in. It runs the command outside OS containment, matching the
v1 command-node behavior. Use this only for workflows and workspaces whose
commands you trust. Older workflows using
`executionMode: "trusted-unrestricted"` can still require the CLI
`--allow-unrestricted-commands` or web “Allow unrestricted commands” option.

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

## Opening the workbench over SSH

`kouro serve` listens on the remote machine's loopback interface. When the
server starts inside an SSH session, it prints a forwarding command. Run that
command in a terminal on your own computer, replacing `<same-SSH-target>` with
the host or SSH config alias you used to connect. Keep it running, then open
the printed `http://127.0.0.1:...` workbench URL in your local browser. The
browser connects through the tunnel while Kouro stays bound to loopback on the
remote machine.
