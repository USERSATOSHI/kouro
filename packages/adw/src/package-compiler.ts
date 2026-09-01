import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fromAsync, ok, safeCall, type Result } from '@usersatoshi/results';

import type {
  CompiledWorkflowArtifact,
  JsonValue,
  SourceNodeDefinition,
  SourceSubagentDefinition,
  WorkflowSourceBundle,
} from '@kouro/domain';
import { compareCanonicalText, sha256 } from './canonical.ts';
import { compileWorkflow } from './compiler.ts';
import { expandWorkflowComposition } from './composition.ts';
import { CompilerErrorKind, toErr, toCompilerError, type CompilerError } from './errors.ts';
import type { WorkflowAuthoringDefinition } from './sdk.ts';

export const COMPILER_VERSION = '0.5.0';
export const IR_VERSION = '5';
export const EXPRESSION_VERSION = '1';

interface AdwManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly kouro: string;
  readonly entrypoint: string;
  readonly permissions: readonly string[];
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const child of value) {
      const json = toJsonValue(child);
      if (json === undefined) return undefined;
      result.push(json);
    }
    return result;
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const json = toJsonValue(child);
      if (json === undefined) return undefined;
      result[key] = json;
    }
    return result;
  }
  return undefined;
}

function validateManifest(value: unknown, file: string): Result<AdwManifest, CompilerError> {
  if (!isRecord(value)) {
    return toCompilerError(CompilerErrorKind.ManifestInvalid, {
      file,
      reason: 'manifest must be an object',
    });
  }

  for (const field of ['id', 'name', 'version', 'entrypoint']) {
    if (typeof value[field] !== 'string' || !value[field]) {
      return toCompilerError(CompilerErrorKind.ManifestInvalid, {
        file,
        reason: `${field} must be a non-empty string`,
      });
    }
  }
  const kouro = value.kouro ?? value.kairo;
  if (typeof kouro !== 'string' || !kouro) {
    return toCompilerError(CompilerErrorKind.ManifestInvalid, {
      file,
      reason: 'kouro must be a non-empty string',
    });
  }
  if (
    !Array.isArray(value.permissions) ||
    !value.permissions.every((permission) => typeof permission === 'string')
  ) {
    return toCompilerError(CompilerErrorKind.ManifestInvalid, {
      file,
      reason: 'permissions must be a string array',
    });
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return toCompilerError(CompilerErrorKind.ManifestInvalid, {
      file,
      reason: 'description must be a string',
    });
  }

  return ok({
    id: String(value.id),
    name: String(value.name),
    version: String(value.version),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    kouro,
    entrypoint: String(value.entrypoint),
    permissions: value.permissions,
  });
}

function validateDefinition(
  value: unknown,
  file: string,
): Result<WorkflowAuthoringDefinition, CompilerError> {
  if (!isRecord(value)) {
    return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
      file,
      reason: 'default export must be a workflow object',
    });
  }
  for (const field of ['id', 'version', 'entry']) {
    if (typeof value[field] !== 'string' || !value[field]) {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `${field} must be a non-empty string`,
      });
    }
  }
  if (!isRecord(value.nodes) || Object.keys(value.nodes).length === 0) {
    return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
      file,
      reason: 'nodes must be a non-empty object',
    });
  }
  if (!Array.isArray(value.transitions)) {
    return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
      file,
      reason: 'transitions must be an array',
    });
  }
  for (const [nodeId, node] of Object.entries(value.nodes)) {
    if (!isRecord(node) || typeof node.type !== 'string') {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `node ${nodeId} must be a node object`,
      });
    }
    if (
      node.type === 'call' &&
      (typeof node.workflow !== 'string' || node.workflow.trim().length === 0)
    ) {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `call node ${nodeId} must name a subworkflow`,
      });
    }
    if (node.type === 'parallel') {
      if (
        !isRecord(node.branches) ||
        Object.keys(node.branches).length === 0 ||
        Object.values(node.branches).some(
          (alias) => typeof alias !== 'string' || alias.trim().length === 0,
        )
      ) {
        return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
          file,
          reason: `parallel node ${nodeId} must map branch IDs to subworkflow aliases`,
        });
      }
    }
    if (node.type === 'for_each') {
      const itemsFrom = node.itemsFrom;
      const sourceNode = isRecord(itemsFrom) ? itemsFrom.node : undefined;
      const path = isRecord(itemsFrom) ? itemsFrom.path : undefined;
      if (
        !isRecord(itemsFrom) ||
        (typeof sourceNode !== 'string' &&
          (!isRecord(sourceNode) || typeof sourceNode.id !== 'string')) ||
        !Array.isArray(path) ||
        path.some((segment) => typeof segment !== 'string')
      ) {
        return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
          file,
          reason: `forEach node ${nodeId} must declare itemsFrom node and JSON path`,
        });
      }
    }
    if (
      node.type === 'sleep' &&
      (typeof node.durationMs !== 'number' ||
        !Number.isSafeInteger(node.durationMs) ||
        node.durationMs <= 0)
    ) {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `sleep node ${nodeId} must declare a positive durationMs`,
      });
    }
    if (node.type === 'wait_for_event' && typeof node.event !== 'string') {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `waitForEvent node ${nodeId} must declare an event`,
      });
    }
  }
  for (const transition of value.transitions) {
    if (
      !isRecord(transition) ||
      typeof transition.id !== 'string' ||
      !isRecord(transition.from) ||
      typeof transition.from.nodeId !== 'string' ||
      typeof transition.from.outcome !== 'string' ||
      typeof transition.toNodeId !== 'string'
    ) {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: 'every transition must be structurally valid',
      });
    }
  }
  if (value.subagents !== undefined && !isRecord(value.subagents)) {
    return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
      file,
      reason: 'subagents must be an object',
    });
  }
  for (const [subagentId, subagent] of Object.entries(value.subagents ?? {})) {
    if (
      !isRecord(subagent) ||
      typeof subagent.role !== 'string' ||
      typeof subagent.prompt !== 'string'
    ) {
      return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
        file,
        reason: `subagent ${subagentId} must be a subagent object`,
      });
    }
  }

  // ADW modules are trusted authoring inputs and the required runtime shape is checked above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return ok(value as unknown as WorkflowAuthoringDefinition);
}

function containedPath(packageDirectory: string, resource: string): string | undefined {
  if (isAbsolute(resource)) return undefined;
  const absolute = resolve(packageDirectory, resource);
  const child = relative(packageDirectory, absolute);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return absolute;
}

async function readResource(
  packageDirectory: string,
  resource: string,
): Promise<Result<{ path: string; content: string }, CompilerError>> {
  const absolute = containedPath(packageDirectory, resource);
  if (!absolute) {
    return toCompilerError(CompilerErrorKind.ResourceInvalid, {
      file: resource,
      reason: 'resource escapes the ADW package',
    });
  }
  const content = await fromAsync(
    () => readFile(absolute, 'utf8'),
    () => toErr(CompilerErrorKind.ResourceFileNotFound, { file: absolute }),
  );
  if (content.isErr()) return content;
  return ok({ path: absolute, content: content.unwrap() });
}

async function importDefault(
  file: string,
  content: string,
  errorKind: CompilerErrorKind.EntrypointLoadFailed | CompilerErrorKind.ResourceInvalid,
): Promise<Result<unknown, CompilerError>> {
  const url = pathToFileURL(file);
  url.searchParams.set('kouro', sha256(content).slice(7));
  return fromAsync(
    async () => {
      const module = await import(url.href);
      return module.default as unknown;
    },
    (cause) =>
      errorKind === CompilerErrorKind.EntrypointLoadFailed
        ? toErr(errorKind, { file, cause: causeText(cause) })
        : toErr(errorKind, {
            file,
            reason: causeText(cause),
          }),
  );
}

async function resolveSchema(
  packageDirectory: string,
  resource: string,
): Promise<Result<JsonValue, CompilerError>> {
  const loaded = await readResource(packageDirectory, resource);
  if (loaded.isErr()) return loaded;
  const loadedResource = loaded.unwrap();

  let value: unknown;
  if (extname(loadedResource.path) === '.json') {
    const parsed = safeCall(
      () => JSON.parse(loadedResource.content) as unknown,
      (cause) =>
        toErr(CompilerErrorKind.ResourceInvalid, {
          file: loadedResource.path,
          reason: causeText(cause),
        }),
    );
    if (parsed.isErr()) return parsed;
    value = parsed.unwrapOr(undefined);
  } else {
    const imported = await importDefault(
      loadedResource.path,
      loadedResource.content,
      CompilerErrorKind.ResourceInvalid,
    );
    if (imported.isErr()) return imported;
    value = imported.unwrapOr(undefined);
  }

  const json = toJsonValue(value);
  if (json === undefined) {
    return toCompilerError(CompilerErrorKind.ResourceInvalid, {
      file: loadedResource.path,
      reason: 'schema must be finite JSON data',
    });
  }
  return ok(json);
}

async function loadManifest(packageDirectory: string): Promise<Result<AdwManifest, CompilerError>> {
  const file = resolve(packageDirectory, 'manifest.json');
  const content = await fromAsync(
    () => readFile(file, 'utf8'),
    () => toErr(CompilerErrorKind.ManifestFileNotFound, { file }),
  );
  if (content.isErr()) return content;
  const parsed = safeCall(
    () => JSON.parse(content.unwrap()) as unknown,
    (cause) =>
      toErr(CompilerErrorKind.ManifestInvalid, {
        file,
        reason: causeText(cause),
      }),
  );
  if (parsed.isErr()) return parsed;
  return validateManifest(parsed.unwrapOr(undefined), file);
}

async function loadDefinition(
  packageDirectory: string,
  entrypoint: string,
): Promise<Result<WorkflowAuthoringDefinition, CompilerError>> {
  const loaded = await readResource(packageDirectory, entrypoint);
  if (loaded.isErr()) {
    return toCompilerError(CompilerErrorKind.EntrypointLoadFailed, {
      file: entrypoint,
      cause: JSON.stringify(loaded.error),
    });
  }
  const loadedResource = loaded.unwrap();
  const imported = await importDefault(
    loadedResource.path,
    loadedResource.content,
    CompilerErrorKind.EntrypointLoadFailed,
  );
  if (imported.isErr()) return imported;
  return validateDefinition(imported.unwrapOr(undefined), loadedResource.path);
}

async function compilePackage(
  packageDirectory: string,
  stack: readonly string[],
): Promise<Result<CompiledWorkflowArtifact, CompilerError>> {
  const absolutePackage = resolve(packageDirectory);
  const existingIndex = stack.indexOf(absolutePackage);
  if (existingIndex >= 0) {
    return toCompilerError(CompilerErrorKind.SubworkflowCycle, {
      packages: [...stack.slice(existingIndex), absolutePackage],
    });
  }
  const nextStack = [...stack, absolutePackage];

  const manifestResult = await loadManifest(absolutePackage);
  if (manifestResult.isErr()) return manifestResult;
  const manifest = manifestResult.unwrap();

  const definitionResult = await loadDefinition(absolutePackage, manifest.entrypoint);
  if (definitionResult.isErr()) return definitionResult;
  const definition = definitionResult.unwrap();

  if (definition.id !== manifest.id || definition.version !== manifest.version) {
    return toCompilerError(CompilerErrorKind.DefinitionInvalid, {
      file: resolve(absolutePackage, manifest.entrypoint),
      reason: 'definition id and version must match manifest',
    });
  }

  const manifestPermissions = new Set(manifest.permissions);
  for (const permission of definition.permissions ?? []) {
    if (!manifestPermissions.has(permission)) {
      return toCompilerError(CompilerErrorKind.ManifestInvalid, {
        file: resolve(absolutePackage, 'manifest.json'),
        reason: `definition permission is absent from manifest: ${permission}`,
      });
    }
  }

  const prompts: Record<string, string> = {};
  const schemas: Record<string, JsonValue> = {};
  const nodes: SourceNodeDefinition[] = [];
  for (const [id, authoringNode] of Object.entries(definition.nodes).toSorted(([left], [right]) =>
    compareCanonicalText(left, right),
  )) {
    const node = authoringNode;
    if (node.type === 'agent') {
      const prompt = await readResource(absolutePackage, node.prompt);
      if (prompt.isErr()) return prompt;
      prompts[node.prompt] = prompt.unwrap().content;
      if (node.outputSchema) {
        const schema = await resolveSchema(absolutePackage, node.outputSchema);
        if (schema.isErr()) return schema;
        schemas[node.outputSchema] = schema.unwrap();
      }
    }
    if (node.type === 'wait_for_event' && node.payloadSchema) {
      const schema = await resolveSchema(absolutePackage, node.payloadSchema);
      if (schema.isErr()) return schema;
      schemas[node.payloadSchema] = schema.unwrap();
    }
    if (node.type === 'for_each') {
      const sourceNodeId =
        typeof node.itemsFrom.node === 'string' ? node.itemsFrom.node : node.itemsFrom.node.id;
      nodes.push({
        id,
        ...node,
        itemsFrom: { nodeId: sourceNodeId, path: [...node.itemsFrom.path] },
      });
    } else {
      nodes.push({ id, ...node });
    }
  }
  const subagents: SourceSubagentDefinition[] = [];
  for (const [id, authoringSubagent] of Object.entries(definition.subagents ?? {}).toSorted(
    ([left], [right]) => compareCanonicalText(left, right),
  )) {
    const prompt = await readResource(absolutePackage, authoringSubagent.prompt);
    if (prompt.isErr()) return prompt;
    prompts[authoringSubagent.prompt] = prompt.unwrap().content;
    if (authoringSubagent.outputSchema) {
      const schema = await resolveSchema(absolutePackage, authoringSubagent.outputSchema);
      if (schema.isErr()) return schema;
      schemas[authoringSubagent.outputSchema] = schema.unwrap();
    }
    subagents.push({ id, ...authoringSubagent });
  }

  const subworkflows: Record<
    string,
    {
      checksum: string;
      bundle: CompiledWorkflowArtifact['bundle'];
    }
  > = {};
  for (const [alias, reference] of Object.entries(definition.subworkflows ?? {}).toSorted(
    ([left], [right]) => compareCanonicalText(left, right),
  )) {
    const compiled = await compilePackage(resolve(absolutePackage, reference.package), nextStack);
    if (compiled.isErr()) return compiled;
    const compiledSubworkflow = compiled.unwrap();
    if (compiledSubworkflow.bundle.manifest.version !== reference.version) {
      return toCompilerError(CompilerErrorKind.SubworkflowVersionMismatch, {
        package: reference.package,
        expected: reference.version,
        received: compiledSubworkflow.bundle.manifest.version,
      });
    }
    subworkflows[alias] = {
      checksum: compiledSubworkflow.checksum,
      bundle: compiledSubworkflow.bundle,
    };
  }

  const source: WorkflowSourceBundle = {
    manifest: {
      id: manifest.id,
      version: manifest.version,
      metadata: {
        name: manifest.name,
        description: manifest.description ?? '',
        kouro: manifest.kouro,
        entrypoint: manifest.entrypoint,
      },
    },
    semanticVersions: {
      compiler: COMPILER_VERSION,
      ir: IR_VERSION,
      expressions: EXPRESSION_VERSION,
    },
    entryNodeId: definition.entry,
    nodes,
    ...(subagents.length > 0 ? { subagents } : {}),
    transitions: definition.transitions,
    counterLimits: definition.limits?.counters ?? {},
    ...(definition.limits?.maxDurationMs === undefined &&
    definition.limits?.maxNodeInvocations === undefined &&
    definition.limits?.maxConcurrentInvocations === undefined
      ? {}
      : {
          runLimits: {
            ...(definition.limits.maxDurationMs === undefined
              ? {}
              : { maxDurationMs: definition.limits.maxDurationMs }),
            ...(definition.limits.maxNodeInvocations === undefined
              ? {}
              : { maxNodeInvocations: definition.limits.maxNodeInvocations }),
            ...(definition.limits.maxConcurrentInvocations === undefined
              ? {}
              : { maxConcurrentInvocations: definition.limits.maxConcurrentInvocations }),
          },
        }),
    prompts,
    schemas,
    permissions: definition.permissions ?? manifest.permissions,
    defaults: definition.defaults ?? {},
    subworkflows,
  };

  const expanded = expandWorkflowComposition(source);
  return expanded.isErr() ? expanded : compileWorkflow(expanded.unwrap());
}

export function compileAdwPackage(
  packageDirectory: string,
): Promise<Result<CompiledWorkflowArtifact, CompilerError>> {
  return compilePackage(packageDirectory, []);
}
