import { canonicalize, validateJsonSchema } from "@kouro/core";
import type { Bundle, JsonObject, Port } from "@kouro/core";
import type { WorkItemInput } from "./types.ts";

const HOST_OWNED_INPUTS = new Set(["__kouroExecutionProfile", "__kouroWorkspace", "__kouroFork"]);

export function normalizeWorkItemInput(input: Record<string, unknown>): WorkItemInput | undefined {
  const rawWorkItem = input.workItem;
  const rawTask = input.task;
  const rawTaskText = typeof rawTask === "string" ? rawTask.trim() : undefined;

  if (rawTask !== undefined && typeof rawTask !== "string")
    throw new Error("task input must be a string");
  if (rawTaskText !== undefined && !rawTaskText) throw new Error("task input must be nonblank");

  let workItem: WorkItemInput | undefined;
  if (rawWorkItem !== undefined) {
    if (!isRecord(rawWorkItem)) throw new Error("workItem input must be an object");
    if (rawWorkItem.version !== 1) throw new Error("workItem.version must be 1");
    if (typeof rawWorkItem.task !== "string" || !rawWorkItem.task.trim())
      throw new Error("workItem.task must be nonblank");
    const workTask = rawWorkItem.task.trim();
    if (rawTaskText !== undefined && rawTaskText !== workTask)
      throw new Error("task and workItem.task conflict");

    const rawTicket = rawWorkItem.ticket;
    if (rawTicket !== undefined) {
      if (
        !isRecord(rawTicket) ||
        typeof rawTicket.reference !== "string" ||
        !rawTicket.reference.trim()
      )
        throw new Error("workItem.ticket.reference must be nonblank");
      if (!isRecord(rawTicket.snapshot))
        throw new Error("ticket-only admission is unsupported without an immutable snapshot");
      validateTicketSnapshot(rawTicket.snapshot);
    }
    workItem = {
      version: 1,
      task: workTask,
      ...(rawTicket ? { ticket: rawTicket as unknown as WorkItemInput["ticket"] } : {}),
      ...optionalString(rawWorkItem.title, "workItem.title"),
      ...optionalString(rawWorkItem.description, "workItem.description"),
      ...optionalString(rawWorkItem.source, "workItem.source"),
    };
  } else if (rawTaskText !== undefined) {
    workItem = { version: 1, task: rawTaskText };
  }

  if (input.ticket !== undefined)
    throw new Error("ticket admission requires workItem.ticket with an immutable snapshot");
  return workItem;
}

export function normalizeAdmissionInput(
  bundle: Bundle,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = input ? { ...input } : {};
  for (const key of HOST_OWNED_INPUTS)
    if (key in source) throw new Error(`input field ${key} is host-owned`);

  const workItem = normalizeWorkItemInput(source);
  const normalized: Record<string, unknown> = { ...source };
  if (workItem) {
    normalized.task = workItem.task;
    normalized.workItem = workItem;
  } else {
    delete normalized.task;
    delete normalized.workItem;
  }
  validateRootInputs(bundle, normalized);
  return normalized;
}

export function validateRootInputs(bundle: Bundle, input: Record<string, unknown>): void {
  const root = bundle.definitions[bundle.rootDefinitionId];
  if (!root) throw new Error(`Bundle root definition ${bundle.rootDefinitionId} is unavailable`);
  for (const port of root.inputPorts) validatePortValue(bundle, port, input[port.name]);
}

function validatePortValue(bundle: Bundle, port: Port, value: unknown): void {
  if (value === undefined) {
    if (port.required && port.defaultValue === undefined)
      throw new Error(`Missing required workflow input ${port.name}`);
    return;
  }
  const schema = bundle.schemas[port.schemaDigest];
  if (schema === undefined) throw new Error(`Missing input schema ${port.schemaDigest}`);
  const validation = validateJsonSchema(value, schema);
  if (!validation.valid)
    throw new Error(`Invalid workflow input ${port.name}: ${validation.error}`);
}

function validateTicketSnapshot(value: Record<string, unknown>): void {
  if (value.version !== 1) throw new Error("ticket snapshot version must be 1");
  for (const [key, label] of [
    ["provider", "ticket snapshot provider"],
    ["externalId", "ticket snapshot external ID"],
    ["title", "ticket snapshot title"],
    ["body", "ticket snapshot body"],
  ] as const)
    if (typeof value[key] !== "string") throw new Error(`${label} is required`);
  if (typeof value.revision !== "string" && typeof value.capturedAt !== "string")
    throw new Error("ticket snapshot requires revision or capturedAt");
}

function optionalString(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return { [field.slice(field.indexOf(".") + 1)]: value };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function admissionDigest(input: {
  workflowId: string;
  bundleDigest: string;
  input: Record<string, unknown>;
  executionProfile?: string;
  workspace?: { repositoryPath: string; workspaceId?: string };
}): string {
  return canonicalize({
    workflowId: input.workflowId,
    bundleDigest: input.bundleDigest,
    input: input.input,
    executionProfile: input.executionProfile ?? null,
    workspace: input.workspace ?? null,
  });
}
