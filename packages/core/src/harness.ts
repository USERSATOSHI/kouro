import type { Harness, JsonObject, JsonValue, RuntimeHarness } from "./contracts";
import { canonicalize, sha256Hex } from "./canonical";
import Ajv2020 from "ajv/dist/2020.js";

type BaseCapability =
  | "structured-output"
  | "cancel"
  | "resume"
  | "reattach"
  | "tools"
  | "usage"
  | "cost-cap";
export type Capability =
  | BaseCapability
  | "awaited-subagent-tool"
  | "child-read-only-envelope"
  | "steer";
export type Availability = "available" | "unavailable";
export interface CapabilityState {
  readonly state: "supported" | "unsupported" | "conditional";
  readonly constraints?: readonly string[];
}

export interface HarnessDescriptor {
  readonly id: RuntimeHarness;
  readonly adapterVersion: string;
  readonly version: string;
  readonly capabilities: Readonly<
    Record<BaseCapability, CapabilityState> &
      Partial<Record<Exclude<Capability, BaseCapability>, CapabilityState>>
  >;
  readonly nativeConfigSchema: JsonValue;
  readonly availability: Availability;
  readonly detail?: string;
}

export interface RoleSpec {
  readonly id: string;
  readonly prompt: string;
  readonly outputSchema?: JsonValue;
}
export interface ModelSpec {
  readonly id: string;
  readonly provider?: string;
  readonly config?: JsonObject;
}
export interface HarnessSelection {
  readonly harness: Harness;
  readonly model: ModelSpec;
  readonly nativeConfig?: JsonObject;
}

export interface ContextSegment {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly supplied: boolean;
  readonly reason?: string;
  readonly bytes: number;
  readonly tokenCount: number | null;
  readonly tokenQuality: "exact" | "estimated" | "unavailable";
  readonly summaryOf?: readonly string[];
}
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly enabled: boolean;
}
export interface ContextManifest {
  readonly version: 1;
  readonly attemptId: string;
  readonly segments: readonly ContextSegment[];
  readonly tools: readonly ToolDefinition[];
  readonly hiddenNativeContext: "unavailable" | "reported";
  readonly digest: string;
}

export interface UsageValue {
  readonly value: number | null;
  readonly quality: "observed" | "estimated" | "unavailable";
  readonly source?: string;
}
export interface UsageSummary {
  readonly inputTokens: UsageValue;
  readonly outputTokens: UsageValue;
  readonly totalTokens: UsageValue;
  readonly cost: UsageValue;
}
export interface HarnessResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "unavailable";
  readonly output?: JsonValue;
  readonly rawOutput?: string;
  /** Separate native stderr stream, retained independently from stdout. */
  readonly stderr?: string;
  readonly usage: UsageSummary;
  readonly error?: string;
  readonly events: readonly HarnessEvent[];
}
export interface StartTurnRequest {
  readonly attemptId: string;
  readonly operationKey: string;
  readonly role: RoleSpec;
  readonly selection: HarnessSelection;
  readonly context: ContextManifest;
  readonly cwd?: string;
}
export interface TurnHandle {
  readonly observations: AsyncIterable<HarnessEvent>;
  cancel(reason: string): Promise<void>;
  close(): Promise<void>;
}
export interface HarnessPort {
  readonly descriptor: HarnessDescriptor;
  startTurn(request: StartTurnRequest): Promise<TurnHandle>;
}
export type HarnessEvent = {
  readonly type: "text" | "log" | "tool" | "usage";
  readonly at: string;
  readonly data: JsonValue;
};

export interface AttemptPolicy {
  readonly maxAttempts: number;
  readonly retryOn: readonly ("invalid-output" | "transport" | "cancelled" | "unavailable")[];
  readonly fallback?: HarnessSelection;
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonValue,
): { valid: true } | { valid: false; error: string } {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const check = ajv.compile(schema as unknown as object);
    return check(value)
      ? { valid: true }
      : {
          valid: false,
          error: (check.errors ?? [])
            .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
            .join(", "),
        };
  } catch (error) {
    return { valid: false, error: `invalid schema: ${String(error)}` };
  }
}

export async function createContextManifest(
  input: Omit<ContextManifest, "version" | "digest">,
): Promise<ContextManifest> {
  const base = { ...input, version: 1 as const };
  const digest = await sha256Hex(canonicalize(base));
  return Object.freeze({ ...base, digest: `sha256:${digest}` });
}

export function unavailableUsage(): UsageSummary {
  const unavailable = { value: null, quality: "unavailable" as const };
  return {
    inputTokens: unavailable,
    outputTokens: unavailable,
    totalTokens: unavailable,
    cost: unavailable,
  };
}

export function canEnforceCostCap(descriptor: HarnessDescriptor): boolean {
  return descriptor.capabilities["cost-cap"].state === "supported";
}

export function validateNativeConfig(
  descriptor: HarnessDescriptor,
  config: JsonObject,
): { valid: true } | { valid: false; error: string } {
  return validateJsonSchema(config, descriptor.nativeConfigSchema);
}

export function redactSecrets(value: unknown, secretNames: readonly string[] = []): unknown {
  if (typeof value === "string")
    return secretNames.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secretNames));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretNames.includes(key) ? "[REDACTED]" : redactSecrets(item, secretNames),
      ]),
    );
  return value;
}

export async function runWithBoundedFallback<T extends { status: string }>(
  run: (selection: HarnessSelection, attempt: number) => Promise<T>,
  primary: HarnessSelection,
  policy: AttemptPolicy,
): Promise<{ result: T; attempts: number; selection: HarnessSelection }> {
  const max = Math.max(1, Math.floor(policy.maxAttempts));
  let selection = primary;
  let result = await run(selection, 1);
  let attempts = 1;
  while (attempts < max && policy.retryOn.includes(result.status as never) && policy.fallback) {
    selection = policy.fallback;
    attempts += 1;
    result = await run(selection, attempts);
  }
  return { result, attempts, selection };
}
