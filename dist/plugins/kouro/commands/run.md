---
description: Execute one existing workflow with a task.
argument-hint: <workflow> <task>
disable-model-invocation: true
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/implement/references/commands.md.
Parse the first argument as the workflow ID and preserve the rest as one task string. Default PROJECT to the invoking session's current project directory unless the user selects another. Run `kouro run WORKFLOW --task TASK --workspace PROJECT` from that project using safely quoted or structured arguments. Await its outcome and preserve ordinary workflow gates.

User arguments: $ARGUMENTS
