import type { JsonObject } from "@kouro/core";

/** Native tools remain subject to the workflow node's grants. */
export interface NativeToolPolicy {
  write: boolean;
  terminal: boolean;
  network: boolean;
  child: boolean;
}

export function nativeToolPolicy(config: JsonObject = {}): NativeToolPolicy {
  const declared = config.toolPolicy;
  const policy =
    declared && typeof declared === "object" && !Array.isArray(declared) ? declared : {};
  const write =
    typeof policy.write === "boolean"
      ? policy.write
      : config.sandbox === "workspace-write" || config.permissionMode === "acceptEdits";
  const child = policy.child === true;
  return {
    write: !child && write,
    terminal: !child && (policy.terminal === true || (policy.terminal === undefined && write)),
    network: !child && policy.network === true,
    child,
  };
}

export function claudeDisallowedTools(policy: NativeToolPolicy): string[] {
  return [
    // Native delegation would bypass declared .subagent bounds and durable reporting.
    "Agent",
    "Task",
    ...(!policy.write ? ["Edit", "Write", "NotebookEdit"] : []),
    ...(!policy.terminal ? ["Bash"] : []),
    ...(!policy.network ? ["WebSearch", "WebFetch"] : []),
  ];
}

export function piExcludedTools(policy: NativeToolPolicy): string[] {
  return [...(!policy.write ? ["edit", "write"] : []), ...(!policy.terminal ? ["bash"] : [])];
}
