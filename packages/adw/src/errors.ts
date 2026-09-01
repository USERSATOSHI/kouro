import { err } from '@usersatoshi/results';

export const enum CompilerErrorKind {
  DuplicateNode = 0,
  DuplicateTransition = 1,
  EntryNodeNotFound = 2,
  TransitionNodeNotFound = 3,
  InvalidDefault = 4,
  InvalidCounterLimit = 5,
  UnknownCounter = 6,
  UnboundedCycle = 7,
  InvalidNodeId = 8,
  InvalidNodeConfiguration = 9,
  UnreachableNode = 10,
  InvalidExpression = 11,
  PermissionNotDeclared = 12,
  ManifestFileNotFound = 13,
  ManifestInvalid = 14,
  EntrypointLoadFailed = 15,
  DefinitionInvalid = 16,
  ResourceFileNotFound = 17,
  ResourceInvalid = 18,
  SubworkflowVersionMismatch = 19,
  SubworkflowCycle = 20,
  InvalidTransition = 21,
  InvalidRunLimit = 22,
  InvalidSubagentId = 23,
  DuplicateSubagent = 24,
  InvalidSubagentConfiguration = 25,
  UnknownSubagent = 26,
  SubagentCapabilityEscalation = 27,
  GeneratedNodeId = 28,
  UnknownSubworkflow = 29,
  SubworkflowPermissionEscalation = 30,
  InvalidComposition = 31,
}

export type CompilerError =
  | { readonly kind: CompilerErrorKind.DuplicateNode; readonly nodeId: string }
  | {
      readonly kind: CompilerErrorKind.DuplicateTransition;
      readonly transitionId: string;
    }
  | {
      readonly kind: CompilerErrorKind.EntryNodeNotFound;
      readonly nodeId: string;
    }
  | {
      readonly kind: CompilerErrorKind.TransitionNodeNotFound;
      readonly transitionId: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidDefault;
      readonly nodeId: string;
      readonly outcome: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidCounterLimit;
      readonly counter: string;
      readonly limit: number;
    }
  | {
      readonly kind: CompilerErrorKind.UnknownCounter;
      readonly transitionId: string;
      readonly counter: string;
    }
  | {
      readonly kind: CompilerErrorKind.UnboundedCycle;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly kind: CompilerErrorKind.InvalidNodeId;
      readonly nodeId: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidNodeConfiguration;
      readonly nodeId: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.UnreachableNode;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly kind: CompilerErrorKind.InvalidExpression;
      readonly transitionId: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.PermissionNotDeclared;
      readonly nodeId: string;
      readonly permission: string;
    }
  | {
      readonly kind: CompilerErrorKind.ManifestFileNotFound;
      readonly file: string;
    }
  | {
      readonly kind: CompilerErrorKind.ManifestInvalid;
      readonly file: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.EntrypointLoadFailed;
      readonly file: string;
      readonly cause: string;
    }
  | {
      readonly kind: CompilerErrorKind.DefinitionInvalid;
      readonly file: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.ResourceFileNotFound;
      readonly file: string;
    }
  | {
      readonly kind: CompilerErrorKind.ResourceInvalid;
      readonly file: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.SubworkflowVersionMismatch;
      readonly package: string;
      readonly expected: string;
      readonly received: string;
    }
  | {
      readonly kind: CompilerErrorKind.SubworkflowCycle;
      readonly packages: readonly string[];
    }
  | {
      readonly kind: CompilerErrorKind.InvalidTransition;
      readonly transitionId: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidRunLimit;
      readonly limit: 'maxDurationMs' | 'maxNodeInvocations' | 'maxConcurrentInvocations';
      readonly value: number;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidSubagentId;
      readonly subagentId: string;
    }
  | {
      readonly kind: CompilerErrorKind.DuplicateSubagent;
      readonly subagentId: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidSubagentConfiguration;
      readonly subagentId: string;
      readonly reason: string;
    }
  | {
      readonly kind: CompilerErrorKind.UnknownSubagent;
      readonly nodeId: string;
      readonly subagentId: string;
    }
  | {
      readonly kind: CompilerErrorKind.SubagentCapabilityEscalation;
      readonly nodeId: string;
      readonly subagentId: string;
      readonly capability: string;
    }
  | {
      readonly kind: CompilerErrorKind.GeneratedNodeId;
      readonly nodeId: string;
    }
  | {
      readonly kind: CompilerErrorKind.UnknownSubworkflow;
      readonly nodeId: string;
      readonly alias: string;
    }
  | {
      readonly kind: CompilerErrorKind.SubworkflowPermissionEscalation;
      readonly nodeId: string;
      readonly alias: string;
      readonly permission: string;
    }
  | {
      readonly kind: CompilerErrorKind.InvalidComposition;
      readonly nodeId: string;
      readonly reason: string;
    };

export function toErr<K extends CompilerError['kind']>(
  kind: K,
  details: Omit<Extract<CompilerError, { kind: K }>, 'kind'>,
): Extract<CompilerError, { kind: K }> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    kind,
    ...details,
  } as Extract<CompilerError, { kind: K }>;
}

export function toCompilerError<K extends CompilerError['kind']>(
  kind: K,
  details: Omit<Extract<CompilerError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<CompilerError, { kind: K }>>> {
  return err(toErr(kind, details));
}
