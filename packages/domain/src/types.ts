export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Portable reasoning-depth policy used by workflow agents and run defaults. */
export type AgentReasoningEffort = 'low' | 'medium' | 'high';

export interface WorkItemSnapshot {
  readonly schemaVersion: 1;
  readonly kind: 'inline' | 'ticket';
  readonly provider: string;
  readonly reference: string;
  readonly revision?: string;
  readonly url?: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly labels: readonly string[];
  readonly checksum: `sha256:${string}`;
}

export type RecoveryPolicy =
  | 'replay_safe'
  | 'verify_then_replay'
  | 'resume_supported'
  | 'manual_reconciliation'
  | 'never_automatically_retry';

export type ValueReference =
  | {
      readonly scope: 'counter';
      readonly name: string;
    }
  | {
      readonly scope: 'output';
      readonly path: readonly string[];
    };

export type Expression =
  | {
      readonly op: 'eq';
      readonly left: ValueReference;
      readonly right: JsonPrimitive;
    }
  | {
      readonly op: 'gte';
      readonly left: ValueReference;
      readonly right: JsonPrimitive;
    }
  | {
      readonly op: 'lt';
      readonly left: ValueReference;
      readonly right: JsonPrimitive;
    }
  | {
      readonly op: 'and';
      readonly expressions: readonly Expression[];
    }
  | {
      readonly op: 'or';
      readonly expressions: readonly Expression[];
    }
  | {
      readonly op: 'not';
      readonly expression: Expression;
    };

export interface SourceNodeDefinition {
  readonly id: string;
  readonly type: 'agent' | 'approval' | 'command' | 'complete' | 'delivery_review';
  readonly priority?: number;
  readonly recoveryPolicy?: RecoveryPolicy;
  readonly capabilities?: readonly string[];
  readonly command?: string;
  readonly title?: string;
  readonly proposalFrom?: string;
  readonly role?: string;
  readonly prompt?: string;
  readonly outputSchema?: string;
  readonly harness?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly allowedSubagents?: readonly string[];
  readonly contextSources?: readonly AgentContextSource[];
  readonly clearContext?: boolean;
  readonly result?: 'succeeded' | 'failed';
  readonly skipOutcome?: string;
}

/** Explicit durable structured-output source available to a consuming agent. */
export type AgentContextSource =
  | { readonly type: 'agent'; readonly id: string }
  | { readonly type: 'subagent'; readonly id: string };

export interface SourceSubagentDefinition {
  readonly id: string;
  readonly role: string;
  readonly prompt: string;
  readonly outputSchema?: string;
  readonly harness?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly capabilities: readonly string[];
  readonly maxInvocations: number;
  readonly maxConcurrent: number;
}

export interface NodeDefinition extends SourceNodeDefinition {
  readonly ordinal: number;
  readonly priority: number;
}

export interface SourceTransition {
  readonly id: string;
  readonly from: {
    readonly nodeId: string;
    readonly outcome: string;
  };
  readonly toNodeId: string;
  readonly condition?: Expression;
  readonly default?: true;
  readonly increment?: string;
}

export interface CompiledTransition extends SourceTransition {}

export interface WorkflowSourceBundle {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
    readonly metadata?: Readonly<Record<string, JsonValue>>;
  };
  readonly semanticVersions: {
    readonly compiler: string;
    readonly ir: string;
    readonly expressions: string;
  };
  readonly entryNodeId: string;
  readonly nodes: readonly SourceNodeDefinition[];
  readonly subagents?: readonly SourceSubagentDefinition[];
  readonly transitions: readonly SourceTransition[];
  readonly counterLimits: Readonly<Record<string, number>>;
  readonly runLimits?: {
    readonly maxDurationMs?: number;
    readonly maxNodeInvocations?: number;
  };
  readonly prompts?: Readonly<Record<string, string>>;
  readonly schemas?: Readonly<Record<string, JsonValue>>;
  readonly permissions?: readonly string[];
  readonly defaults?: Readonly<Record<string, JsonValue>>;
  readonly subworkflows?: Readonly<
    Record<
      string,
      {
        readonly checksum: string;
        readonly bundle: CompiledWorkflowBundle;
      }
    >
  >;
}

export interface CompiledWorkflowBundle extends Omit<
  WorkflowSourceBundle,
  'nodes' | 'transitions'
> {
  readonly nodes: readonly NodeDefinition[];
  readonly transitions: readonly CompiledTransition[];
}

export interface CompiledWorkflowArtifact {
  readonly bundle: CompiledWorkflowBundle;
  readonly canonical: string;
  readonly checksum: `sha256:${string}`;
}

export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type InvocationState =
  | 'pending'
  | 'active'
  | 'waiting_for_approval'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AttemptState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';

export interface ArtifactReference {
  readonly id: string;
  readonly kind:
    | 'agent_output'
    | 'harness_transcript'
    | 'command_output'
    | 'git_diff'
    | 'git_status'
    | 'delivery_proposal';
  readonly mediaType: string;
  readonly checksum: `sha256:${string}`;
  readonly size: number;
}

export interface AttemptFailure {
  readonly kind: string;
  readonly message: string;
}

export interface AgentSteeringRequest {
  readonly requestSequence: number;
  readonly actor: string;
  readonly message: string;
  readonly state: 'pending' | 'applied' | 'rejected';
  readonly reason?: string;
}

/**
 * Token usage reported by a coding-agent harness for one attempt.
 *
 * Fields are provider-agnostic counts gathered at the harness boundary. Cost
 * is never persisted here; it is a derived display value computed from this
 * usage and a model price table at the edge.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** Durable operator metadata for one child execution owned by a parent attempt. */
export interface SubagentExecutionSummary {
  readonly sequence: number;
  readonly callId: string;
  readonly subagentId: string;
  readonly task: string;
  readonly harnessId: string;
  readonly model?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly state: 'succeeded' | 'failed';
  readonly error?: string;
  readonly output?: JsonValue;
  readonly usage?: TokenUsage;
}

export interface NodeAttempt {
  readonly number: number;
  readonly state: AttemptState;
  readonly harnessId?: string;
  readonly model?: string;
  readonly resumeToken?: string;
  readonly steering?: readonly AgentSteeringRequest[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly failure?: AttemptFailure;
  readonly usage?: TokenUsage;
  /** Subordinate executions owned by this attempt; never scheduler inputs. */
  readonly subagents?: readonly SubagentExecutionSummary[];
}

export interface NodeInvocation {
  readonly sequence: number;
  readonly nodeId: string;
  readonly state: InvocationState;
  readonly attempts: readonly NodeAttempt[];
  readonly outcome?: string;
  readonly output?: JsonValue;
  readonly selectedTransitionId?: string;
  readonly approval?: ApprovalBinding;
}

export interface ApprovalBinding {
  readonly workflowChecksum: string;
  readonly invocationSequence: number;
  readonly artifactChecksums: readonly string[];
  readonly resolvedAction: string;
  readonly repositoryHead: string;
  readonly preparedTree?: string;
  readonly proposalChecksum?: string;
}

export interface DeliveryMetadata {
  readonly commitTitle: string;
  readonly commitBody?: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody?: string;
  readonly draft: boolean;
}

export interface DeliveryProposal {
  readonly invocationSequence: number;
  readonly preparedHead: string;
  readonly preparedTree: string;
  readonly metadata: DeliveryMetadata;
  readonly artifactChecksums: readonly string[];
  readonly checksum: `sha256:${string}`;
}

export interface PullRequestPublication {
  readonly status: 'not_published' | 'publishing' | 'published' | 'failed';
  readonly provider?: 'github' | 'forgejo';
  readonly remote?: string;
  readonly number?: number;
  readonly url?: string;
  readonly error?: string;
}

export interface DeliveryState {
  readonly proposal?: DeliveryProposal;
  readonly repairsUsed: number;
  readonly commit?: string;
  readonly branch?: string;
  readonly publication: PullRequestPublication;
}

export interface SkipBinding {
  readonly workflowChecksum: string;
  readonly invocationSequence: number;
  readonly artifactChecksums: readonly string[];
  readonly selectedOutcome: string;
  readonly repositoryHead: string;
}

export interface RunState {
  readonly workflowChecksum: string;
  readonly startingCommit: string;
  readonly repositoryHead: string;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly startedAt?: string;
  readonly observedAt?: string;
  readonly status: RunStatus;
  readonly nextInvocationSequence: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly invocations: readonly NodeInvocation[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly delivery?: DeliveryState;
}

export type RunEvent =
  | {
      readonly sequence: number;
      readonly type: 'run.created';
      readonly workflowChecksum: string;
      readonly startingCommit: string;
      readonly configuration: Readonly<Record<string, JsonValue>>;
      readonly startedAt?: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.time_observed';
      readonly observedAt: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.paused';
      readonly actor: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.resumed';
      readonly actor: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.cancelled';
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'invocation.activated';
      readonly invocationSequence: number;
      readonly nodeId: string;
      readonly sourceInvocationSequence?: number;
      readonly transitionId?: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.started';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly harnessId?: string;
      readonly model?: string;
      readonly resumeToken?: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.resumed';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly harnessId: string;
      readonly resumeToken: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.resume_token_recorded';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly resumeToken: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.usage_recorded';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly usage: TokenUsage;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.subagents_recorded';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly subagents: readonly SubagentExecutionSummary[];
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.artifact_published';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly artifact: ArtifactReference;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.artifact_published';
      readonly artifact: ArtifactReference;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.proposed';
      readonly proposal: DeliveryProposal;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.metadata_updated';
      readonly invocationSequence: number;
      readonly metadata: DeliveryMetadata;
      readonly checksum: `sha256:${string}`;
      readonly actor: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.committed';
      readonly invocationSequence: number;
      readonly preparedTree: string;
      readonly commit: string;
      readonly branch: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.publication_started';
      readonly provider: 'github' | 'forgejo';
      readonly remote: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.publication_succeeded';
      readonly provider: 'github' | 'forgejo';
      readonly remote: string;
      readonly number: number;
      readonly url: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'delivery.publication_failed';
      readonly provider: 'github' | 'forgejo';
      readonly remote: string;
      readonly error: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.failed';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly failure: AttemptFailure;
      readonly retry: 'fallback' | 'none';
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.interrupted';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
    }
  | {
      readonly sequence: number;
      readonly type: 'attempt.interrupt_requested';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'agent.steering_requested';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly actor: string;
      readonly message: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'agent.steering_applied';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly requestSequence: number;
    }
  | {
      readonly sequence: number;
      readonly type: 'agent.steering_rejected';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
      readonly requestSequence: number;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'invocation.retry_requested';
      readonly invocationSequence: number;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'invocation.skipped';
      readonly binding: SkipBinding;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'invocation.completed';
      readonly invocationSequence: number;
      readonly outcome: string;
      readonly output?: JsonValue;
    }
  | {
      readonly sequence: number;
      readonly type: 'approval.requested';
      readonly binding: ApprovalBinding;
    }
  | {
      readonly sequence: number;
      readonly type: 'approval.granted';
      readonly binding: ApprovalBinding;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'approval.rejected';
      readonly binding: ApprovalBinding;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'approval.changes_requested';
      readonly binding: ApprovalBinding;
      readonly actor: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'run.completed';
      readonly result: 'succeeded' | 'failed';
    };

export type RunEventInput = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, 'sequence'>
    : never
  : never;

export type OrchestrationIntent =
  | {
      readonly type: 'invocation.activate';
      readonly nodeId: string;
      readonly invocationSequence: number;
      readonly sourceInvocationSequence?: number;
      readonly transitionId?: string;
    }
  | {
      readonly type: 'attempt.schedule';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
    }
  | {
      readonly type: 'approval.request';
      readonly invocationSequence: number;
      readonly binding: ApprovalBinding;
    }
  | {
      readonly type: 'effect.verify';
      readonly invocationSequence: number;
      readonly attemptNumber: number;
    }
  | {
      readonly type: 'session.resume';
      readonly invocationSequence: number;
      readonly token: string;
    }
  | {
      readonly type: 'reconciliation.request';
      readonly invocationSequence: number;
    }
  | {
      readonly type: 'recovery.halt';
      readonly invocationSequence: number;
    }
  | {
      readonly type: 'run.complete';
      readonly result: 'succeeded' | 'failed';
    };
