import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileAdwPackage } from '@kouro/adw';
import {
  createKouroApp,
  KouroTicketRunQuery,
  LocalArtifactContentReader,
  LocalEvaluationDatasetSource,
  type KouroApp,
  type EvaluationServices,
  type ObservableRunStore,
} from '@kouro/api';
import type {
  CreateRunRequest,
  CreateRunResponse,
  DeleteRunResponse,
  RepositorySummary,
} from '@kouro/api-contracts';
import {
  deliveryMetadataChecksum,
  ensurePullRequest,
  validateDeliveryMetadata,
  type PullRequestProvider,
} from '@kouro/delivery';
import { ForgejoPullRequestProvider } from '@kouro/delivery-provider-forgejo';
import { GitHubPullRequestProvider } from '@kouro/delivery-provider-github';
import type { DeliveryMetadata, DeliveryProposal } from '@kouro/domain';
import type { TicketProviderConfigurationView } from '@kouro/api-contracts';
import {
  AgentExecutor,
  type AgentHarness,
  BunCommandRunner,
  RunCoordinator,
  RunStoreErrorKind,
  type RunAggregate,
  type RunStoreError,
  type TicketProvider,
} from '@kouro/executors';
import {
  ClaudeCodeHarness,
  CodexHarness,
  HarnessRegistry,
  LocalArtifactWriter,
  LocalInvocationActivityStore,
  OpenCodeHarness,
  PiHarness,
} from '@kouro/harnesses';
import { SqliteEvaluationStore, SqliteEventStore } from '@kouro/persistence-sqlite';
import {
  SandboxRuntimeAgentCommandSandbox,
  WorktreeSandboxProvider,
  type RunWorktree,
} from '@kouro/sandbox-worktree';
import { ParallelWorktreeManager } from './parallel-worktree-manager.ts';
import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  SqliteTicketSyncStore,
  TicketMigrationService,
  type TicketMigrationError,
  type TicketPriority,
  type TicketProvider as RemoteTicketProvider,
  TicketErrorKind,
  TicketRunService,
  TicketService,
  TicketSyncErrorKind,
  TicketSyncService,
  type TicketSyncError,
  type Ticket,
  type TicketComment,
  type TicketError,
  type TicketStatus,
  type UpdateTicketInput,
  toTicketError,
  toTicketSyncError,
} from '@kouro/tickets';
import { err, ok, type Result } from '@usersatoshi/results';

import { CliErrorKind, cliErr, type CliError } from './errors.ts';
import { resolveLocalPaths, type LocalPaths } from './paths.ts';
import { composeTicketProviders, type TicketProviderComposition } from './ticket-composition.ts';
import {
  createInlineWorkItem,
  createStoredTicketWorkItem,
  resolveTicketWorkItem,
  workItemConfiguration,
} from './work-item.ts';
import { LocalWorker } from './worker.ts';

interface RunConfiguration {
  readonly worktreePath: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly deliveryBranch: string;
  readonly operator: string;
  readonly baseBranch: string;
  readonly deliveryLifecycleVersion?: number;
}

function runConfiguration(aggregate: RunAggregate): RunConfiguration | undefined {
  const value = aggregate.state.configuration;
  return typeof value.worktreePath === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.repositoryPath === 'string' &&
    typeof value.deliveryBranch === 'string' &&
    typeof value.operator === 'string'
    ? {
        worktreePath: value.worktreePath,
        repositoryId: value.repositoryId,
        repositoryPath: value.repositoryPath,
        deliveryBranch: value.deliveryBranch,
        operator: value.operator,
        baseBranch: typeof value.baseBranch === 'string' ? value.baseBranch : '',
        ...(typeof value.deliveryLifecycleVersion === 'number'
          ? { deliveryLifecycleVersion: value.deliveryLifecycleVersion }
          : {}),
      }
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function environmentValue(name: string): string | undefined {
  return process.env[name]?.trim() ?? process.env[name.replace(/^KOURO_/, 'KAIRO_')]?.trim();
}

interface ConfiguredPullRequestProvider {
  readonly provider: PullRequestProvider;
  readonly owner: string;
  readonly repository: string;
}

export interface HarnessDiagnostic {
  readonly id: string;
  readonly available: boolean;
  readonly terminalSandbox: 'provider-native' | 'sandbox-runtime';
  readonly terminalAvailable: boolean;
  readonly reason?: string;
}

function pullRequestProviders(): ReadonlyMap<'github' | 'forgejo', ConfiguredPullRequestProvider> {
  const providers = new Map<'github' | 'forgejo', ConfiguredPullRequestProvider>();
  const githubOwner = environmentValue('KOURO_GITHUB_OWNER');
  const githubRepository = environmentValue('KOURO_GITHUB_REPOSITORY');
  const githubToken = environmentValue('KOURO_GITHUB_TOKEN');
  if (githubOwner && githubRepository && githubToken) {
    const apiUrl = environmentValue('KOURO_GITHUB_API_URL');
    providers.set('github', {
      owner: githubOwner,
      repository: githubRepository,
      provider: new GitHubPullRequestProvider({
        token: githubToken,
        ...(apiUrl ? { apiUrl } : {}),
      }),
    });
  }
  const forgejoUrl = environmentValue('KOURO_FORGEJO_URL');
  const forgejoOwner = environmentValue('KOURO_FORGEJO_OWNER');
  const forgejoRepository = environmentValue('KOURO_FORGEJO_REPOSITORY');
  const forgejoToken = environmentValue('KOURO_FORGEJO_TOKEN');
  if (forgejoUrl && forgejoOwner && forgejoRepository && forgejoToken) {
    providers.set('forgejo', {
      owner: forgejoOwner,
      repository: forgejoRepository,
      provider: new ForgejoPullRequestProvider({
        instanceUrl: forgejoUrl,
        token: forgejoToken,
      }),
    });
  }
  return providers;
}

/** Returns the stable local identity used to scope runs to a repository path. */
export function repositoryIdForPath(path: string): string {
  return `repo-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}`;
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function belongsToRepository(aggregate: RunAggregate, repositoryId: string): boolean {
  return aggregate.state.configuration.repositoryId === repositoryId;
}

class RepositoryScopedRunStore implements ObservableRunStore {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly repositoryId: string,
  ) {}

  loadRun(runId: string): Result<RunAggregate, RunStoreError> {
    const loaded = this.store.loadRun(runId);
    return loaded.isErr() || belongsToRepository(loaded.unwrap(), this.repositoryId)
      ? loaded
      : err({ kind: RunStoreErrorKind.RunNotFound, runId });
  }

  listRuns(): Result<readonly RunAggregate[], RunStoreError> {
    const listed = this.store.listRuns();
    return listed.isErr()
      ? listed
      : ok(listed.unwrap().filter((run) => belongsToRepository(run, this.repositoryId)));
  }
}

function harnessRouteError(
  nodeIds: ReadonlyMap<string, string>,
  routes: Readonly<Record<string, readonly string[]>> | undefined,
): string | undefined {
  if (!routes) return undefined;
  for (const [nodeId, harnesses] of Object.entries(routes)) {
    if (nodeIds.get(nodeId) !== 'agent') {
      return `Harness route ${nodeId} does not name a compiled agent node`;
    }
    if (
      harnesses.length === 0 ||
      harnesses.some((harnessId) => typeof harnessId !== 'string' || !harnessId.trim())
    ) {
      return `Harness route ${nodeId} must contain at least one harness ID`;
    }
  }
  return undefined;
}

function harnessCapabilityError(
  nodes: readonly {
    readonly id: string;
    readonly type: string;
    readonly harness?: string;
    readonly capabilities?: readonly string[];
  }[],
  request: Pick<CreateRunRequest, 'harnesses' | 'harnessesByNode'>,
  diagnostics: readonly HarnessDiagnostic[],
): string | undefined {
  const byId = new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]));
  for (const node of nodes) {
    if (node.type !== 'agent') continue;
    const selected =
      request.harnessesByNode?.[node.id] ?? (node.harness ? [node.harness] : request.harnesses);
    if (!selected?.length) continue;
    const known = selected.map((id) => byId.get(id)).filter((value) => value !== undefined);
    if (known.length !== selected.length) continue;
    const needsTerminal = node.capabilities?.includes('terminal.execute') ?? false;
    const usable = known.some(
      (diagnostic) => diagnostic.available && (!needsTerminal || diagnostic.terminalAvailable),
    );
    if (usable) continue;
    const reason = known
      .map(({ id, reason: detail }) => `${id}: ${detail ?? 'unavailable'}`)
      .join('; ');
    return `No selected harness can execute node ${node.id}${needsTerminal ? ' with terminal.execute' : ''}: ${reason}`;
  }
  return undefined;
}

/** Mounts the API under `/api` and serves production web assets as an SPA. */
export function createLocalRequestHandler(
  app: KouroApp,
  webRoot: string,
): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      url.pathname = url.pathname.slice(4) || '/';
      return app.fetch(new Request(url, request));
    }
    if (
      url.pathname === '/health' ||
      url.pathname.startsWith('/runs') ||
      url.pathname.startsWith('/workflows') ||
      url.pathname.startsWith('/repositories') ||
      url.pathname.startsWith('/evaluations') ||
      url.pathname.startsWith('/evaluation-experiments') ||
      url.pathname.startsWith('/tickets') ||
      url.pathname.startsWith('/ticket-projects') ||
      url.pathname.startsWith('/ticket-providers')
    ) {
      return app.fetch(request);
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = Bun.file(resolve(webRoot, relative));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(resolve(webRoot, 'index.html')));
  };
}

export class LocalKouroHost {
  readonly store: SqliteEventStore;
  readonly evaluations: SqliteEvaluationStore;
  readonly evaluationDatasets: LocalEvaluationDatasetSource;
  readonly sandbox: WorktreeSandboxProvider;
  readonly worker: LocalWorker;
  private readonly tickets: SqliteTicketRepository;
  private readonly ticketRuns: SqliteTicketRunStore;
  private readonly ticketSync: SqliteTicketSyncStore;
  private readonly ticketService: TicketService;
  private readonly ticketSyncService: TicketSyncService;
  private readonly ticketMigrationService: TicketMigrationService;
  private readonly remoteTicketProviders: ReadonlyMap<'github' | 'forgejo', RemoteTicketProvider>;
  private readonly ticketProviderViews: readonly TicketProviderConfigurationView[];
  private readonly registry: HarnessRegistry;
  private readonly ticketProviders: ReadonlyMap<string, TicketProvider>;
  private readonly artifactWriter: LocalArtifactWriter;
  private readonly activityStore: LocalInvocationActivityStore;
  private readonly parallelManagers = new Map<string, ParallelWorktreeManager>();
  private initialized = false;

  constructor(
    readonly paths: LocalPaths = resolveLocalPaths(),
    harnesses: readonly AgentHarness[] = [
      new CodexHarness(),
      new ClaudeCodeHarness(),
      new OpenCodeHarness(),
      new PiHarness(),
    ],
    ticketProviders: readonly TicketProvider[] = [],
  ) {
    mkdirSync(paths.dataDirectory, { recursive: true });
    this.store = new SqliteEventStore(paths.databasePath);
    this.evaluations = new SqliteEvaluationStore(paths.databasePath);
    this.evaluationDatasets = new LocalEvaluationDatasetSource();
    this.tickets = new SqliteTicketRepository(paths.databasePath);
    this.ticketRuns = new SqliteTicketRunStore(paths.databasePath);
    this.ticketSync = new SqliteTicketSyncStore(paths.databasePath);
    const clock = { now: (): string => new Date().toISOString() };
    const ids = {
      ticketId: (): string => `ticket-${randomUUID()}`,
      commentId: (): string => `comment-${randomUUID()}`,
    };
    this.ticketService = new TicketService(this.tickets, clock, ids);
    this.ticketSyncService = new TicketSyncService(
      this.tickets,
      this.ticketSync,
      clock,
      ids,
      this.ticketRuns,
      new KouroTicketRunQuery(this.store),
    );
    this.ticketMigrationService = new TicketMigrationService(this.tickets, this.ticketSync, clock);
    const ticketComposition: TicketProviderComposition = composeTicketProviders(
      process.env,
      this.ticketSync,
    );
    this.remoteTicketProviders = ticketComposition.providers;
    this.ticketProviderViews = ticketComposition.configurations;
    this.sandbox = new WorktreeSandboxProvider(paths.worktreeDirectory);
    this.artifactWriter = new LocalArtifactWriter(paths.artifactDirectory);
    this.activityStore = new LocalInvocationActivityStore(paths.artifactDirectory);
    this.registry = new HarnessRegistry(harnesses);
    this.ticketProviders = new Map(ticketProviders.map((provider) => [provider.id, provider]));
    this.worker = new LocalWorker(this.store, {
      coordinatorFor: (aggregate) => this.coordinatorFor(aggregate),
      prepareDelivery: (aggregate) => this.prepareDelivery(aggregate),
      finalize: (aggregate) => this.finalize(aggregate),
    });
  }

  async initialize(): Promise<Result<void, CliError>> {
    try {
      await Promise.all([
        mkdir(this.paths.dataDirectory, { recursive: true }),
        mkdir(this.paths.configDirectory, { recursive: true }),
        mkdir(this.paths.artifactDirectory, { recursive: true }),
      ]);
      const store = this.store.initialize();
      if (store.isErr()) {
        return cliErr(
          CliErrorKind.Initialization,
          'sqlite_initialization_failed',
          'The SQLite store could not be initialized',
        );
      }
      const evaluations = this.evaluations.initialize();
      if (evaluations.isErr()) {
        return cliErr(
          CliErrorKind.Initialization,
          'sqlite_evaluation_initialization_failed',
          'The SQLite evaluation store could not be initialized',
        );
      }
      for (const ticketStore of [this.tickets, this.ticketRuns, this.ticketSync]) {
        const initialized = ticketStore.initialize();
        if (initialized.isErr()) {
          return cliErr(
            CliErrorKind.Initialization,
            'sqlite_ticket_initialization_failed',
            'The SQLite ticket stores could not be initialized',
          );
        }
      }
      const sandbox = await this.sandbox.initialize();
      if (sandbox.isErr()) {
        return cliErr(
          CliErrorKind.Initialization,
          'worktree_initialization_failed',
          message(sandbox.error),
        );
      }
      this.initialized = true;
      return ok(undefined);
    } catch (cause) {
      return cliErr(CliErrorKind.Initialization, 'initialization_failed', message(cause));
    }
  }

  async create(request: CreateRunRequest): Promise<Result<CreateRunResponse, CliError>> {
    return this.createRequest(request, true);
  }

  private async createFromApi(
    request: CreateRunRequest,
  ): Promise<Result<CreateRunResponse, CliError>> {
    return this.createRequest(request, false);
  }

  private async createRequest(
    request: CreateRunRequest,
    advanceUntilStable: boolean,
  ): Promise<Result<CreateRunResponse, CliError>> {
    const ticket = request.ticket?.trim();
    if (ticket?.startsWith('kouro:')) {
      return this.createTicketRun(
        request,
        ticket.slice('kouro:'.length).trim(),
        advanceUntilStable,
      );
    }
    if (ticket?.startsWith('kairo:')) {
      return this.createTicketRun(
        request,
        ticket.slice('kairo:'.length).trim(),
        advanceUntilStable,
      );
    }
    return this.createRun(request, undefined, advanceUntilStable);
  }

  private async createRun(
    request: CreateRunRequest,
    suppliedWorkItem?: import('@kouro/domain').WorkItemSnapshot,
    advanceUntilStable = true,
  ): Promise<Result<CreateRunResponse, CliError>> {
    if (!this.initialized) {
      return cliErr(
        CliErrorKind.Initialization,
        'host_not_initialized',
        'Kouro is not initialized',
      );
    }
    const packageDirectory =
      request.adw === 'feature-development'
        ? resolve(import.meta.dir, '..', 'assets', 'adws', 'feature-development')
        : resolve(request.adw);
    const compiled = await compileAdwPackage(packageDirectory);
    if (compiled.isErr()) {
      return cliErr(CliErrorKind.Compilation, 'adw_compilation_failed', message(compiled.error));
    }
    const routeError = harnessRouteError(
      new Map(compiled.unwrap().bundle.nodes.map(({ id, type }) => [id, type])),
      request.harnessesByNode,
    );
    if (routeError) {
      return cliErr(CliErrorKind.InvalidArguments, 'invalid_harness_route', routeError);
    }
    const capabilityError = harnessCapabilityError(
      compiled.unwrap().bundle.nodes,
      request,
      await this.harnessDiagnostics(),
    );
    if (capabilityError) {
      return cliErr(CliErrorKind.InvalidArguments, 'harness_unavailable', capabilityError);
    }
    const task = request.task?.trim();
    const ticket = request.ticket?.trim();
    if (request.task !== undefined && !task) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_work_item',
        'Task text must be non-empty',
      );
    }
    if (request.ticket !== undefined && !ticket) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_ticket_reference',
        'Ticket reference must be non-empty',
      );
    }
    if (task && ticket) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'multiple_work_items',
        'Use exactly one of task or ticket',
      );
    }
    if (request.adw === 'feature-development' && !task && !ticket && !suppliedWorkItem) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'work_item_required',
        'feature-development requires --ticket, --task, or --task-file',
      );
    }
    const workItem = suppliedWorkItem
      ? ok(suppliedWorkItem)
      : task
        ? createInlineWorkItem(task)
        : ticket
          ? await resolveTicketWorkItem(ticket, this.ticketProviders)
          : undefined;
    if (workItem?.isErr()) {
      return cliErr(CliErrorKind.InvalidArguments, workItem.error.code, workItem.error.message);
    }
    const id = createRunId();
    const repoId = repositoryIdForPath(request.repositoryPath);
    const registered = await this.sandbox.registerRepository(repoId, request.repositoryPath);
    if (registered.isErr()) {
      return cliErr(
        CliErrorKind.Repository,
        'repository_registration_failed',
        message(registered.error),
      );
    }
    const pinned = await this.sandbox.pinStartingCommit(registered.unwrap());
    if (pinned.isErr()) {
      return cliErr(CliErrorKind.Repository, 'starting_commit_failed', message(pinned.error));
    }
    const baseBranch = await this.sandbox.resolveBaseBranch(pinned.unwrap(), request.base);
    if (baseBranch.isErr()) {
      return cliErr(CliErrorKind.Repository, 'base_branch_failed', message(baseBranch.error));
    }
    const worktree = await this.sandbox.createWorktree(pinned.unwrap(), id);
    if (worktree.isErr()) {
      return cliErr(CliErrorKind.Repository, 'worktree_creation_failed', message(worktree.error));
    }
    const harnesses = request.harnesses?.length
      ? request.harnesses
      : ['codex', 'claude-code', 'opencode', 'pi'];
    const parallelManager = new ParallelWorktreeManager(
      this.sandbox,
      repoId,
      request.repositoryPath,
      worktree.unwrap().path,
      id,
    );
    this.parallelManagers.set(id, parallelManager);
    const created = this.coordinator(worktree.unwrap().path, parallelManager).createRun({
      runId: id,
      artifact: compiled.unwrap(),
      startingCommit: pinned.unwrap().startingCommit,
      configuration: {
        adw: request.adw,
        agentHarnesses: harnesses,
        ...(request.harnessesByNode ? { agentHarnessesByNode: request.harnessesByNode } : {}),
        ...(request.reasoningEffort ? { agentReasoningEffort: request.reasoningEffort } : {}),
        ...(workItem?.isOk() ? { workItem: workItemConfiguration(workItem.unwrap()) } : {}),
        requestedPermissions: compiled.unwrap().bundle.permissions ?? [],
        repositoryId: repoId,
        repositoryPath: pinned.unwrap().repositoryPath,
        worktreePath: worktree.unwrap().path,
        deliveryBranch: `kouro/${id}`,
        baseBranch: baseBranch.unwrap(),
        deliveryLifecycleVersion: 1,
        operator: request.actor,
      },
      idempotencyKey: `create:${id}`,
    });
    if (created.isErr()) {
      return cliErr(CliErrorKind.Persistence, 'run_creation_failed', message(created.error));
    }
    if (!advanceUntilStable) {
      this.worker.start();
      return ok({ runId: id, status: created.unwrap().state.status });
    }
    const stable = await this.worker.runUntilStable(id);
    return ok({ runId: id, status: stable.state.status });
  }

  private async createTicketRun(
    request: CreateRunRequest,
    ticketId: string,
    advanceUntilStable: boolean,
  ): Promise<Result<CreateRunResponse, CliError>> {
    if (!ticketId) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_ticket_reference',
        'Kouro ticket references must use kouro:<ticket-id>',
      );
    }
    if (request.task !== undefined) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'multiple_work_items',
        'Use exactly one of task or ticket',
      );
    }
    let response: CreateRunResponse | undefined;
    const service = new TicketRunService(
      this.tickets,
      this.ticketRuns,
      new KouroTicketRunQuery(this.store),
      {
        start: async ({ ticket, snapshot }) => {
          const workItem = createStoredTicketWorkItem(ticket, snapshot);
          if (workItem.isErr()) {
            return toTicketError(TicketErrorKind.InvalidInput, {
              field: 'ticketId',
              reason: workItem.error.message,
            });
          }
          const created = await this.createRun(
            { ...request, ticket: undefined },
            workItem.unwrap(),
            advanceUntilStable,
          );
          if (created.isErr()) {
            return toTicketError(TicketErrorKind.InvalidInput, {
              field: 'ticketId',
              reason: created.error.message,
            });
          }
          response = created.unwrap();
          return ok({ runId: response.runId });
        },
      },
      { now: (): string => new Date().toISOString() },
      {
        ticketId: (): string => `ticket-${randomUUID()}`,
        commentId: (): string => `comment-${randomUUID()}`,
        snapshotId: (): string => `snapshot-${randomUUID()}`,
      },
    );
    const started = await service.start({
      ticketId,
      kind: 'implementation',
      workflow: request.adw,
      repositoryPath: request.repositoryPath,
      actor: request.actor,
    });
    if (started.isErr()) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'ticket_run_failed',
        JSON.stringify(started.error),
      );
    }
    return response
      ? ok(response)
      : cliErr(
          CliErrorKind.Persistence,
          'ticket_run_missing',
          'Ticket run started without a run response',
        );
  }

  coordinatorFor(aggregate: RunAggregate): RunCoordinator {
    const configuration = runConfiguration(aggregate);
    const workingDirectory = configuration?.worktreePath ?? process.cwd();
    const parallelManager = configuration
      ? (this.parallelManagers.get(aggregate.runId) ??
        new ParallelWorktreeManager(
          this.sandbox,
          configuration.repositoryId,
          configuration.repositoryPath,
          workingDirectory,
          aggregate.runId,
        ))
      : undefined;
    if (parallelManager) this.parallelManagers.set(aggregate.runId, parallelManager);
    return this.coordinator(workingDirectory, parallelManager);
  }

  coordinator(
    workingDirectory = process.cwd(),
    parallelWorkspaces?: ParallelWorktreeManager,
  ): RunCoordinator {
    return new RunCoordinator(
      this.store,
      new BunCommandRunner(workingDirectory),
      new AgentExecutor(this.registry, this.artifactWriter, this.activityStore),
      workingDirectory,
      undefined,
      parallelWorkspaces,
    );
  }

  updateDeliveryMetadata(
    aggregate: RunAggregate,
    invocationSequence: number,
    metadata: DeliveryMetadata,
    actor: string,
    idempotencyKey: string,
  ): Result<RunAggregate, CliError> {
    const proposal = aggregate.state.delivery?.proposal;
    if (!proposal || proposal.invocationSequence !== invocationSequence) {
      return cliErr(
        CliErrorKind.Lifecycle,
        'delivery_proposal_not_pending',
        'Delivery metadata can only be edited on the pending proposal',
      );
    }
    const validated = validateDeliveryMetadata(metadata);
    if (validated.isErr()) {
      return cliErr(CliErrorKind.InvalidArguments, validated.error.code, validated.error.message);
    }
    const checksum = deliveryMetadataChecksum(
      proposal.preparedHead,
      proposal.preparedTree,
      proposal.artifactChecksums,
      validated.value,
    );
    const updated = this.coordinatorFor(aggregate).updateDeliveryMetadata(
      aggregate.runId,
      invocationSequence,
      validated.value,
      checksum,
      actor,
      idempotencyKey,
    );
    return updated.isErr()
      ? cliErr(CliErrorKind.Lifecycle, 'delivery_metadata_stale', message(updated.error))
      : updated;
  }

  async publish(
    runId: string,
    requestedProvider?: 'github' | 'forgejo',
    remote = 'origin',
  ): Promise<
    Result<
      {
        readonly provider: 'github' | 'forgejo';
        readonly number: number;
        readonly url: string;
      },
      CliError
    >
  > {
    const loaded = this.store.loadRun(runId);
    if (loaded.isErr()) {
      return cliErr(CliErrorKind.Persistence, 'run_not_found', `Run ${runId} was not found`);
    }
    let aggregate = loaded.value;
    const delivery = aggregate.state.delivery;
    const configuration = runConfiguration(aggregate);
    if (
      aggregate.state.status !== 'succeeded' ||
      !delivery?.commit ||
      !delivery.branch ||
      !delivery.proposal ||
      !configuration
    ) {
      return cliErr(
        CliErrorKind.Publication,
        'delivery_not_ready',
        'The run must be successfully delivered locally before publication',
      );
    }
    if (delivery.publication.status === 'published') {
      if (
        !delivery.publication.provider ||
        !delivery.publication.number ||
        !delivery.publication.url
      ) {
        return cliErr(
          CliErrorKind.Persistence,
          'publication_state_invalid',
          'The durable publication record is incomplete',
        );
      }
      return ok({
        provider: delivery.publication.provider,
        number: delivery.publication.number,
        url: delivery.publication.url,
      });
    }
    const providers = pullRequestProviders();
    const workItem = aggregate.state.configuration.workItem;
    const boundProvider =
      isRecord(workItem) && (workItem.provider === 'github' || workItem.provider === 'forgejo')
        ? workItem.provider
        : undefined;
    const providerId =
      requestedProvider ??
      (boundProvider && providers.has(boundProvider) ? boundProvider : undefined) ??
      (providers.size === 1 ? [...providers.keys()][0] : undefined);
    if (!providerId) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'publication_provider_required',
        'Choose --provider because no unique configured provider could be inferred',
      );
    }
    const configured = providers.get(providerId);
    if (!configured) {
      return cliErr(
        CliErrorKind.Publication,
        'publication_provider_not_configured',
        `${providerId} pull-request credentials are not configured`,
      );
    }
    const worktree = await this.durableWorktree(aggregate);
    const remoteUrl = await this.sandbox.remoteUrl(worktree, remote);
    if (remoteUrl.isErr()) {
      return cliErr(
        CliErrorKind.Repository,
        'remote_not_found',
        `Remote ${remote} is not configured for ${configuration.repositoryPath}; add the repository remote before publishing`,
      );
    }
    const repositoryPath = `${configured.owner}/${configured.repository}`;
    if (
      !remoteUrl.value.replace(/\.git$/, '').endsWith(`/${repositoryPath}`) &&
      !remoteUrl.value.replace(/\.git$/, '').endsWith(`:${repositoryPath}`)
    ) {
      return cliErr(
        CliErrorKind.Publication,
        'remote_repository_mismatch',
        `Remote ${remote} does not match configured ${providerId} repository ${repositoryPath}`,
      );
    }
    const coordinator = this.coordinatorFor(aggregate);
    const started = coordinator.recordPublication(
      runId,
      { type: 'delivery.publication_started', provider: providerId, remote },
      `publication:start:${aggregate.nextEventSequence}`,
    );
    if (started.isErr()) {
      return cliErr(CliErrorKind.Publication, 'publication_stale', message(started.error));
    }
    aggregate = started.value;
    const pushed = await this.sandbox.pushDeliveryBranch(
      worktree,
      remote,
      delivery.branch,
      delivery.commit,
    );
    if (pushed.isErr()) {
      this.coordinatorFor(aggregate).recordPublication(
        runId,
        {
          type: 'delivery.publication_failed',
          provider: providerId,
          remote,
          error: message(pushed.error),
        },
        `publication:failed:${aggregate.nextEventSequence}`,
      );
      return cliErr(CliErrorKind.Publication, 'branch_push_failed', message(pushed.error));
    }
    const pullRequest = await ensurePullRequest(configured.provider, {
      owner: configured.owner,
      repository: configured.repository,
      head: delivery.branch,
      base: configuration.baseBranch,
      title: delivery.proposal.metadata.pullRequestTitle,
      ...(delivery.proposal.metadata.pullRequestBody
        ? { body: delivery.proposal.metadata.pullRequestBody }
        : {}),
      draft: delivery.proposal.metadata.draft,
    });
    if (pullRequest.isErr()) {
      this.coordinatorFor(aggregate).recordPublication(
        runId,
        {
          type: 'delivery.publication_failed',
          provider: providerId,
          remote,
          error: pullRequest.error.message,
        },
        `publication:failed:${aggregate.nextEventSequence}`,
      );
      return cliErr(CliErrorKind.Publication, pullRequest.error.code, pullRequest.error.message);
    }
    const recorded = this.coordinatorFor(aggregate).recordPublication(
      runId,
      {
        type: 'delivery.publication_succeeded',
        provider: providerId,
        remote,
        number: pullRequest.value.number,
        url: pullRequest.value.url,
      },
      `publication:succeeded:${aggregate.nextEventSequence}`,
    );
    if (recorded.isErr()) {
      return cliErr(CliErrorKind.Publication, 'publication_record_failed', message(recorded.error));
    }
    return ok({
      provider: providerId,
      number: pullRequest.value.number,
      url: pullRequest.value.url,
    });
  }

  app(repositoryPath?: string): KouroApp {
    const scopedRepository = repositoryPath
      ? { id: repositoryIdForPath(repositoryPath), path: resolve(repositoryPath) }
      : undefined;
    const scopeId = scopedRepository?.id;
    const runs = scopeId ? new RepositoryScopedRunStore(this.store, scopeId) : this.store;
    return createKouroApp({
      runs,
      coordinator: this.coordinator(),
      artifacts: new LocalArtifactContentReader(this.paths.artifactDirectory),
      activities: this.activityStore,
      repositories: scopedRepository
        ? {
            list: async () => [scopedRepository],
          }
        : this,
      runCreator: {
        create: (request) =>
          scopeId && repositoryIdForPath(request.repositoryPath) !== scopeId
            ? Promise.resolve(
                cliErr(
                  CliErrorKind.InvalidArguments,
                  'repository_scope_mismatch',
                  'The requested repository is outside this server scope',
                ),
              )
            : this.createFromApi(request),
      },
      runDeleter: this,
      runPublisher: this,
      tickets: {
        repository: this.tickets,
        runs: this.ticketRuns,
        runQuery: new KouroTicketRunQuery(runs),
        sync: this.ticketSync,
      },
      ticketProviders: { list: () => this.ticketProviderViews },
      evaluations: this.evaluationServices(),
    });
  }

  evaluationServices(): EvaluationServices {
    return {
      datasets: this.evaluationDatasets,
      store: this.evaluations,
      clock: { now: () => new Date().toISOString() },
    };
  }

  runStoreForRepository(repositoryPath: string): ObservableRunStore {
    return new RepositoryScopedRunStore(this.store, repositoryIdForPath(repositoryPath));
  }

  async delete(runId: string): Promise<Result<DeleteRunResponse, CliError>> {
    const loaded = this.store.loadRun(runId);
    if (loaded.isErr()) {
      return cliErr(CliErrorKind.Persistence, 'run_not_found', `Run ${runId} was not found`);
    }
    const aggregate = loaded.unwrap();
    if (!['succeeded', 'failed', 'cancelled'].includes(aggregate.state.status)) {
      return cliErr(
        CliErrorKind.Lifecycle,
        'run_not_terminal',
        `Run ${runId} must be terminal before it can be deleted`,
      );
    }
    const configuration = runConfiguration(aggregate);
    if (!configuration) {
      return cliErr(
        CliErrorKind.Persistence,
        'invalid_run_configuration',
        `Run ${runId} has invalid local configuration`,
      );
    }
    const metadataPath = resolve(
      this.paths.worktreeDirectory,
      'runs',
      configuration.repositoryId,
      `${runId}.json`,
    );
    try {
      let commonGitDirectory: string | undefined;
      try {
        const recorded: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (!isRecord(recorded) || typeof recorded.commonGitDirectory !== 'string') {
          return cliErr(
            CliErrorKind.Persistence,
            'invalid_worktree_metadata',
            `Run ${runId} has invalid worktree metadata`,
          );
        }
        commonGitDirectory = recorded.commonGitDirectory;
      } catch (cause) {
        if (!isNotFoundError(cause)) throw cause;
        const worktreeExists = await stat(configuration.worktreePath).then(
          () => true,
          (error: unknown) => {
            if (isNotFoundError(error)) return false;
            throw error;
          },
        );
        if (worktreeExists) {
          return cliErr(
            CliErrorKind.Persistence,
            'missing_worktree_metadata',
            `Run ${runId} still has a worktree but its metadata is missing`,
          );
        }
      }
      if (commonGitDirectory) {
        const cleaned = await this.sandbox.cleanupWorktree(
          {
            repositoryId: configuration.repositoryId,
            runId,
            repositoryPath: configuration.repositoryPath,
            path: configuration.worktreePath,
            commonGitDirectory,
            startingCommit: aggregate.state.startingCommit,
          },
          true,
        );
        if (cleaned.isErr()) {
          return cliErr(
            CliErrorKind.Repository,
            'worktree_deletion_failed',
            message(cleaned.error),
          );
        }
      }
      const artifacts = await this.artifactWriter.deleteRunArtifacts(runId);
      if (artifacts.isErr()) {
        return cliErr(
          CliErrorKind.Persistence,
          'artifact_deletion_failed',
          artifacts.error.message,
        );
      }
      const deleted = this.store.deleteRun(runId);
      if (deleted.isErr()) {
        return cliErr(
          CliErrorKind.Persistence,
          'run_deletion_failed',
          `Run ${runId} could not be deleted`,
        );
      }
      return ok({ runId, deleted: true });
    } catch (cause) {
      return cliErr(CliErrorKind.Persistence, 'run_deletion_failed', message(cause));
    }
  }

  createTicket(input: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly priority?: TicketPriority;
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
  }): Result<Ticket, TicketError> {
    return this.ticketService.create(input);
  }

  listTickets(projectId: string): Result<readonly Ticket[], TicketError> {
    return this.ticketService.list(projectId);
  }

  getTicket(ticketId: string): Result<Ticket, TicketError> {
    return this.ticketService.get(ticketId);
  }

  updateTicket(ticketId: string, input: UpdateTicketInput): Result<Ticket, TicketError> {
    return this.ticketService.update(ticketId, input);
  }

  moveTicket(
    ticketId: string,
    expectedRevision: number,
    status: TicketStatus,
  ): Result<Ticket, TicketError> {
    return this.ticketService.move(ticketId, expectedRevision, status);
  }

  closeTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.close(ticketId, expectedRevision);
  }

  cancelTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.cancel(ticketId, expectedRevision);
  }

  reopenTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.reopen(ticketId, expectedRevision);
  }

  addTicketComment(
    ticketId: string,
    author: string,
    body: string,
  ): Result<TicketComment, TicketError> {
    return this.ticketService.addComment(ticketId, { author, body });
  }

  async importTickets(
    providerId: 'github' | 'forgejo',
    projectId: string,
  ): Promise<Result<readonly Ticket[], TicketSyncError> | undefined> {
    const provider = this.remoteTicketProviders.get(providerId);
    return provider ? this.ticketSyncService.importProject(projectId, provider) : undefined;
  }

  async pullTicket(ticketId: string): Promise<Result<Ticket, TicketSyncError> | undefined> {
    const ticket = this.ticketService.get(ticketId);
    if (ticket.isErr()) {
      return toTicketSyncError(TicketSyncErrorKind.Ticket, { error: ticket.error });
    }
    if (ticket.value.binding.kind === 'local') return undefined;
    const provider = this.remoteTicketProviders.get(ticket.value.binding.kind);
    return provider ? this.ticketSyncService.reconcile(ticketId, provider) : undefined;
  }

  async pushTicket(
    ticketId: string,
    idempotencyKey: string,
  ): Promise<Result<Ticket, TicketSyncError> | undefined> {
    const ticket = this.ticketService.get(ticketId);
    if (ticket.isErr()) {
      return toTicketSyncError(TicketSyncErrorKind.Ticket, { error: ticket.error });
    }
    if (ticket.value.binding.kind === 'local') return undefined;
    const provider = this.remoteTicketProviders.get(ticket.value.binding.kind);
    return provider
      ? this.ticketSyncService.syncTicket(ticketId, provider, idempotencyKey)
      : undefined;
  }

  async migrateTicket(
    ticketId: string,
    projectId: string,
    providerId: 'github' | 'forgejo',
  ): Promise<Result<Ticket, TicketMigrationError> | undefined> {
    const provider = this.remoteTicketProviders.get(providerId);
    return provider
      ? this.ticketMigrationService.migrate(ticketId, projectId, provider)
      : undefined;
  }

  ticketProviderConfigurations(): readonly TicketProviderConfigurationView[] {
    return this.ticketProviderViews;
  }

  async list(): Promise<readonly RepositorySummary[]> {
    const directory = resolve(this.paths.worktreeDirectory, 'repositories');
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).toSorted();
      const repositories: RepositorySummary[] = [];
      for (const file of files) {
        const parsed: unknown = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
        if (
          isRecord(parsed) &&
          typeof parsed.repositoryId === 'string' &&
          typeof parsed.repositoryPath === 'string'
        ) {
          repositories.push({ id: parsed.repositoryId, path: parsed.repositoryPath });
        }
      }
      return repositories;
    } catch {
      return [];
    }
  }

  async harnessDiagnostics(): Promise<readonly HarnessDiagnostic[]> {
    const portable = await new SandboxRuntimeAgentCommandSandbox().availability();
    const portableReason = portable.available
      ? {}
      : { reason: portable.reason ?? 'Sandbox Runtime is unavailable' };
    const opencodeAvailable = Bun.which('opencode') !== null;
    return [
      {
        id: 'codex',
        available: Bun.which('codex') !== null,
        terminalSandbox: 'provider-native',
        terminalAvailable: Bun.which('codex') !== null,
      },
      {
        id: 'claude-code',
        available: true,
        terminalSandbox: 'provider-native',
        terminalAvailable: true,
      },
      {
        id: 'opencode',
        available: opencodeAvailable,
        terminalSandbox: 'sandbox-runtime',
        terminalAvailable: opencodeAvailable && portable.available,
        ...(!opencodeAvailable
          ? { reason: 'OpenCode executable was not found on PATH' }
          : portableReason),
      },
      {
        id: 'pi',
        available: true,
        terminalSandbox: 'sandbox-runtime',
        terminalAvailable: portable.available,
        ...portableReason,
      },
    ];
  }

  async serve(
    port = 4317,
    repositoryPath?: string,
  ): Promise<Result<{ readonly url: string; stop(): void }, CliError>> {
    if (!this.initialized) {
      return cliErr(
        CliErrorKind.Initialization,
        'host_not_initialized',
        'Kouro is not initialized',
      );
    }
    const app = this.app(repositoryPath);
    const webRoot = resolve(fileURLToPath(import.meta.resolve('@kouro/web/assets')), '..');
    const fetch = createLocalRequestHandler(app, webRoot);
    try {
      this.worker.start();
      const server = Bun.serve({
        port,
        fetch,
      });
      return ok({
        url: `http://${server.hostname}:${server.port}`,
        stop: () => server.stop(true),
      });
    } catch (cause) {
      return cliErr(CliErrorKind.Serve, 'serve_failed', message(cause));
    }
  }

  dispose(): void {
    this.worker.dispose();
    this.evaluations.dispose();
    this.ticketSync.dispose();
    this.ticketRuns.dispose();
    this.tickets.dispose();
    this.store.dispose();
    this.parallelManagers.clear();
    this.initialized = false;
  }

  private async durableWorktree(aggregate: RunAggregate): Promise<RunWorktree> {
    const configuration = runConfiguration(aggregate);
    if (!configuration) throw new Error(`Run ${aggregate.runId} has invalid local configuration`);
    const worktree: RunWorktree = {
      repositoryId: configuration.repositoryId,
      runId: aggregate.runId,
      repositoryPath: configuration.repositoryPath,
      path: configuration.worktreePath,
      commonGitDirectory: resolve(configuration.repositoryPath, '.git'),
      startingCommit: aggregate.state.startingCommit,
    };
    const metadataPath = resolve(
      this.paths.worktreeDirectory,
      'runs',
      configuration.repositoryId,
      `${aggregate.runId}.json`,
    );
    const recorded: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (!isRecord(recorded) || typeof recorded.commonGitDirectory !== 'string') {
      throw new Error('Run worktree metadata is corrupt');
    }
    return { ...worktree, commonGitDirectory: recorded.commonGitDirectory };
  }

  private async publishGitArtifacts(
    aggregate: RunAggregate,
    invocationSequence: number,
  ): Promise<RunAggregate> {
    const durableWorktree = await this.durableWorktree(aggregate);
    const captured = await this.sandbox.captureArtifacts(durableWorktree);
    if (captured.isErr()) throw new Error(message(captured.error));
    let current = aggregate;
    for (const source of [captured.unwrap().status, captured.unwrap().diff]) {
      const kind = source.kind === 'status' ? 'git_status' : 'git_diff';
      const content = await readFile(source.path, 'utf8');
      const written = await this.artifactWriter.write({
        runId: aggregate.runId,
        invocationSequence,
        attemptNumber: 0,
        kind,
        mediaType: kind === 'git_diff' ? 'text/x-diff' : 'text/plain',
        content,
      });
      if (written.isErr()) throw new Error(written.error.message);
      const published = this.coordinatorFor(current).publishRunArtifact(
        current.runId,
        written.unwrap(),
        `delivery:${invocationSequence}:${kind}`,
      );
      if (published.isErr()) throw new Error(message(published.error));
      current = published.unwrap();
    }
    return current;
  }

  private proposalMetadata(aggregate: RunAggregate, proposalFrom: string): DeliveryMetadata {
    const source = aggregate.state.invocations
      .filter(({ nodeId, state }) => nodeId === proposalFrom && state === 'succeeded')
      .at(-1)?.output;
    const metadata =
      isRecord(source) && isRecord(source.deliveryMetadata) ? source.deliveryMetadata : undefined;
    const workItem = aggregate.state.configuration.workItem;
    const workItemTitle =
      isRecord(workItem) && typeof workItem.title === 'string'
        ? workItem.title
        : aggregate.artifact.bundle.manifest.id;
    const candidate: DeliveryMetadata = {
      commitTitle:
        metadata && typeof metadata.commitTitle === 'string' ? metadata.commitTitle : workItemTitle,
      ...(metadata && typeof metadata.commitBody === 'string'
        ? { commitBody: metadata.commitBody }
        : {}),
      pullRequestTitle:
        metadata && typeof metadata.pullRequestTitle === 'string'
          ? metadata.pullRequestTitle
          : workItemTitle,
      ...(metadata && typeof metadata.pullRequestBody === 'string'
        ? { pullRequestBody: metadata.pullRequestBody }
        : {}),
      draft: metadata?.draft === true,
    };
    const validated = validateDeliveryMetadata(candidate);
    if (validated.isErr()) throw new Error(validated.error.message);
    return validated.value;
  }

  private async prepareDelivery(aggregate: RunAggregate): Promise<void> {
    const invocation = aggregate.state.invocations.find(({ state, nodeId }) => {
      const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
      return state === 'pending' && definition?.type === 'delivery_review';
    });
    if (!invocation || aggregate.state.delivery?.proposal) return;
    const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    if (definition?.type !== 'delivery_review' || !definition.proposalFrom) return;
    const current = await this.publishGitArtifacts(aggregate, invocation.sequence);
    const durableWorktree = await this.durableWorktree(current);
    const prepared = await this.sandbox.prepareCommit(durableWorktree);
    if (prepared.isErr()) throw new Error(message(prepared.error));
    const artifactChecksums = (current.state.artifacts ?? [])
      .map(({ checksum }) => checksum)
      .toSorted();
    const metadata = this.proposalMetadata(current, definition.proposalFrom);
    const checksum = deliveryMetadataChecksum(
      prepared.value.head,
      prepared.value.tree,
      artifactChecksums,
      metadata,
    );
    const proposal: DeliveryProposal = {
      invocationSequence: invocation.sequence,
      preparedHead: prepared.value.head,
      preparedTree: prepared.value.tree,
      metadata,
      artifactChecksums,
      checksum,
    };
    const written = await this.artifactWriter.write({
      runId: aggregate.runId,
      invocationSequence: invocation.sequence,
      attemptNumber: 0,
      kind: 'delivery_proposal',
      mediaType: 'application/json',
      content: JSON.stringify(proposal, null, 2),
    });
    if (written.isErr()) throw new Error(written.error.message);
    const withArtifact = this.coordinatorFor(current).publishRunArtifact(
      current.runId,
      written.value,
      `delivery:${invocation.sequence}:proposal-artifact`,
    );
    if (withArtifact.isErr()) throw new Error(message(withArtifact.error));
    const proposed = this.coordinatorFor(withArtifact.value).proposeDelivery(
      aggregate.runId,
      proposal,
      `delivery:${invocation.sequence}:proposal`,
    );
    if (proposed.isErr()) throw new Error(message(proposed.error));
  }

  private async finalize(aggregate: RunAggregate): Promise<void> {
    const successfulComplete = aggregate.state.invocations.some(({ state, nodeId }) => {
      const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
      return (
        state === 'pending' && definition?.type === 'complete' && definition.result !== 'failed'
      );
    });
    if (!successfulComplete) return;
    const configuration = runConfiguration(aggregate);
    if (!configuration) throw new Error(`Run ${aggregate.runId} has invalid local configuration`);
    const hasDeliveryReview = aggregate.artifact.bundle.nodes.some(
      ({ type }) => type === 'delivery_review',
    );
    if (!hasDeliveryReview && configuration.deliveryLifecycleVersion === 1) return;
    if (!hasDeliveryReview) {
      await this.finalizeLegacy(aggregate);
      return;
    }
    const proposal = aggregate.state.delivery?.proposal;
    const invocation = aggregate.state.invocations.find(
      ({ sequence, outcome }) =>
        sequence === proposal?.invocationSequence && outcome === 'approved',
    );
    if (!proposal || !invocation || aggregate.state.delivery?.commit) return;
    const durableWorktree = await this.durableWorktree(aggregate);
    const commitMessage = proposal.metadata.commitBody
      ? `${proposal.metadata.commitTitle}\n\n${proposal.metadata.commitBody}`
      : proposal.metadata.commitTitle;
    const committed = await this.sandbox.commitWorktree({
      worktree: durableWorktree,
      expectedHead: proposal.preparedHead,
      expectedTree: proposal.preparedTree,
      message: commitMessage,
      identity: { name: 'Kouro', email: 'kouro@localhost' },
      timestamp: aggregate.state.startedAt ?? new Date(0).toISOString(),
    });
    if (committed.isErr()) throw new Error(message(committed.error));
    const branched = await this.sandbox.createDeliveryBranch(
      durableWorktree,
      configuration.deliveryBranch,
      committed.unwrap().commit,
    );
    if (branched.isErr()) throw new Error(message(branched.error));
    const recorded = this.coordinatorFor(aggregate).recordDeliveryCommit(
      aggregate.runId,
      invocation.sequence,
      proposal.preparedTree,
      committed.value.commit,
      configuration.deliveryBranch,
      `delivery:${invocation.sequence}:committed`,
    );
    if (recorded.isErr()) throw new Error(message(recorded.error));
  }

  private async finalizeLegacy(aggregate: RunAggregate): Promise<void> {
    if (aggregate.state.artifacts?.some(({ id }) => id === '0:0:git_diff')) return;
    const configuration = runConfiguration(aggregate);
    if (!configuration) throw new Error(`Run ${aggregate.runId} has invalid local configuration`);
    const current = await this.publishGitArtifacts(aggregate, 0);
    const durableWorktree = await this.durableWorktree(current);
    const prepared = await this.sandbox.prepareCommit(durableWorktree);
    if (prepared.isErr()) throw new Error(message(prepared.error));
    const committed = await this.sandbox.commitWorktree({
      worktree: durableWorktree,
      expectedHead: prepared.value.head,
      expectedTree: prepared.value.tree,
      message: `Kouro delivery ${aggregate.runId}`,
      identity: { name: 'Kouro', email: 'kouro@localhost' },
      timestamp: aggregate.state.startedAt ?? new Date(0).toISOString(),
    });
    if (committed.isErr()) throw new Error(message(committed.error));
    const branched = await this.sandbox.createDeliveryBranch(
      durableWorktree,
      configuration.deliveryBranch,
      committed.value.commit,
    );
    if (branched.isErr()) throw new Error(message(branched.error));
  }
}
