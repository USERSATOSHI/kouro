import type {
  Bundle,
  Diagnostic,
  JsonObject,
  JsonValue,
  Node,
  WorkflowDefinitionSource,
} from "./contracts";
import { canonicalize, sha256Hex } from "./canonical";
import { compileWorkflowDetailed } from "./compiler";
import { validateJsonSchema } from "./harness";

export interface PromptFixture {
  readonly id: string;
  readonly version?: string;
  readonly template: string;
  readonly variablesSchema: JsonValue;
  readonly variables: JsonObject;
}

export interface PromptVersion {
  readonly id: string;
  readonly version: string;
  readonly template: string;
  readonly variablesSchema: JsonValue;
  readonly digest: string;
}

export interface PromptRenderResult {
  readonly valid: boolean;
  readonly rendered?: string;
  readonly digest: string;
  readonly errors: readonly string[];
}

export interface DevelopmentComparison {
  readonly leftDigest: string;
  readonly rightDigest: string;
  readonly equal: boolean;
  readonly changed: readonly string[];
  readonly affectedNodes: readonly string[];
}

export async function promptVersion(input: Omit<PromptVersion, "digest">): Promise<PromptVersion> {
  return {
    ...input,
    digest: `sha256:${await sha256Hex(canonicalize({ template: input.template, variablesSchema: input.variablesSchema }))}`,
  };
}

export async function renderPromptFixture(fixture: PromptFixture): Promise<PromptRenderResult> {
  const check = validateJsonSchema(fixture.variables, fixture.variablesSchema);
  const errors = check.valid ? [] : [check.error];
  const digest = `sha256:${await sha256Hex(canonicalize({ template: fixture.template, variablesSchema: fixture.variablesSchema }))}`;
  if (!check.valid) return { valid: false, digest, errors };
  const missing = new Set<string>();
  const rendered = fixture.template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined,
        fixture.variables,
      );
    if (value === undefined) {
      missing.add(path);
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  if (missing.size)
    return {
      valid: false,
      digest,
      errors: [...missing].sort().map((path) => `Missing prompt variable: ${path}`),
    };
  return { valid: true, rendered, digest, errors };
}

export function validateSchemaFixture(
  schema: JsonValue,
  value: unknown,
): { valid: true } | { valid: false; errors: readonly string[] } {
  const result = validateJsonSchema(value, schema);
  return result.valid ? result : { valid: false, errors: result.error.split(", ").filter(Boolean) };
}

export async function compileDevelopmentPreview(source: WorkflowDefinitionSource): Promise<{
  readonly bundle?: Bundle;
  readonly diagnostics: readonly Diagnostic[];
}> {
  return compileWorkflowDetailed(source);
}

function nodeSignature(node: Node, bundle: Bundle): string {
  return canonicalize({
    node,
    schemas: node.outputPorts.map((port) => bundle.schemas[port.schemaDigest] ?? port.schemaDigest),
  });
}

export async function compareWorkflowVersions(
  left: Bundle,
  right: Bundle,
): Promise<DevelopmentComparison> {
  const leftNodes = new Map<string, string>();
  const rightNodes = new Map<string, string>();
  for (const definition of Object.values(left.definitions))
    for (const node of definition.nodes)
      leftNodes.set(`${definition.id}:${node.id}`, nodeSignature(node, left));
  for (const definition of Object.values(right.definitions))
    for (const node of definition.nodes)
      rightNodes.set(`${definition.id}:${node.id}`, nodeSignature(node, right));
  const keys = [...new Set([...leftNodes.keys(), ...rightNodes.keys()])].sort();
  const changed = keys.filter((key) => leftNodes.get(key) !== rightNodes.get(key));
  return {
    leftDigest: left.digest,
    rightDigest: right.digest,
    equal: left.digest === right.digest,
    changed,
    affectedNodes: changed,
  };
}
