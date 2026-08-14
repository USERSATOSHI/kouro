#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import packageManifest from '../package.json' with { type: 'json' };

import {
  getArtifact,
  getRun,
  listArtifacts,
  listRuns,
  LocalArtifactContentReader,
} from '@kouro/api';
import type { DeliveryMetadata } from '@kouro/domain';
import { SandboxRuntimeAgentCommandSandbox } from '@kouro/sandbox-worktree';

import { ADW_TEMPLATES, createAdw, isAdwTemplate } from './create-adw.ts';
import { executeEvaluationCommand } from './evaluation-command.ts';
import { LocalKouroHost } from './local-host.ts';
import { executeTicketCommand } from './ticket-command.ts';

const VERSION = packageManifest.version;
const HELP = `Kouro ${VERSION}

Usage:
  kouro <command> [options]

Common usage:
  kouro create adw <name> [--template <template>] [--output <directory>]
  kouro run <adw> --repo <path> (--ticket <provider:reference> | --task <text> | --task-file <path>)
  kouro pause|resume|cancel <run-id>
  kouro serve [--repo <path>]

Workflow:
  create adw      Create an ADW package from a starter template
  run             Compile and execute an ADW
  attach          Reconnect to an interactive run session

Runs:
  runs            List runs for the current repository
  status          Show one run
  delete          Permanently delete one terminal run
  approve         Grant a pending approval
  reject          Reject a pending approval
  request-changes Return a delivery to its implementation agent
  publish         Push a delivered branch and open its pull request
  pause           Pause scheduling for a run
  resume          Resume a paused run
  cancel          Cancel a run
  interrupt       Interrupt an active invocation
  steer           Send guidance to an active agent invocation
  retry           Retry an interrupted invocation
  skip            Skip a policy-eligible invocation

Planning:
  ticket          Create, inspect, move, sync, and migrate tickets

Evaluation:
  eval            List datasets, evaluate runs, and record human evidence

Host:
  serve           Serve the current repository dashboard and API
  diagnostics     Report available agent harnesses
  sandbox         Inspect or provision the command sandbox

Global options:
  -h, --help      Show help
  -v, --version   Show version

Run "kouro help <command>" for command-specific usage.

ADW templates: ${ADW_TEMPLATES.join(', ')}`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  create: `Usage:
  kouro create adw <name> [--template <template>] [--output <directory>]

Creates .kouro/<name> by default.
Templates: ${ADW_TEMPLATES.join(', ')}`,
  run: `Usage:
  kouro run <adw> --repo <path> (--ticket <provider:reference> | --task <text> | --task-file <path>) [--base <branch>] [--no-interactive] [--harness <id|node=id>]...

Examples:
  kouro run feature-development --repo . --task "Add CSV export" --harness codex
  kouro run feature-development --repo . --ticket kouro:<ticket-id> --harness plan=codex`,
  attach: `Usage:
  kouro attach <run-id> [--repo <path> | --all-repos]

Reconnects to approvals and interventions for a visible local run.`,
  runs: `Usage:
  kouro runs [--repo <path> | --all-repos]

Lists the current repository by default.`,
  status: `Usage:
  kouro status <run-id> [--repo <path> | --all-repos]`,
  delete: `Usage:
  kouro delete <run-id> --yes [--repo <path> | --all-repos]

Permanently removes a terminal run, its Kouro worktree, artifacts, events, and projections.
The source repository and delivery branch are preserved.`,
  approve: `Usage:
  kouro approve <run-id> <invocation> --reason <text> [--metadata <json-file>]`,
  reject: `Usage:
  kouro reject <run-id> <invocation> --reason <text>`,
  'request-changes': `Usage:
  kouro request-changes <run-id> <invocation> --reason <text>`,
  publish: `Usage:
  kouro publish <run-id> [--provider github|forgejo] [--remote <name>]`,
  pause: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  resume: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  cancel: `Usage:
  kouro pause|resume|cancel <run-id> [--reason <text>]`,
  interrupt: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  steer: `Usage:
  kouro steer <run-id> <invocation> --message <text>`,
  retry: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  skip: `Usage:
  kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`,
  ticket: `Usage:
  kouro ticket create --project <id> --title <text> (--description <text> | --description-file <path>) [options]
  kouro ticket list --project <id>
  kouro ticket show <ticket-id>
  kouro ticket update <ticket-id> --revision <number> [options]
  kouro ticket move <ticket-id> --revision <number> --status <status>
  kouro ticket close|cancel|reopen <ticket-id> --revision <number>
  kouro ticket comment <ticket-id> --body <text> [--author <name>]
  kouro ticket providers
  kouro ticket import <github|forgejo> --project <id>
  kouro ticket pull|push <ticket-id>
  kouro ticket migrate <ticket-id> --to <github|forgejo> --project <id>`,
  eval: `Usage:
  kouro eval datasets [--repo <path>]
  kouro eval run <run-id> --dataset <id> --case <id> --experiment <id> [--repo <path>]
  kouro eval reports (--run <run-id> | --experiment <id>)
  kouro eval annotate <report-id> --verdict pass|fail|unsure --note <text>
  kouro eval prefer <experiment-id> <left-report-id> <right-report-id> --winner left|right|tie --reason <text>`,
  serve: `Usage:
  kouro serve [--port <number>] [--repo <path> | --all-repos]

Serves only the current repository by default. It can monitor a CLI-owned run
without interrupting it and takes over execution when the worker lease becomes available.`,
  diagnostics: `Usage:
  kouro diagnostics`,
  sandbox: `Usage:
  kouro sandbox status
  kouro sandbox setup

Windows setup provisions the dedicated sandbox account and network policy.
macOS and Linux require no host provisioning; status reports missing tools.`,
};

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deliveryMetadata(value: unknown): DeliveryMetadata | undefined {
  return isRecord(value) &&
    typeof value.commitTitle === 'string' &&
    typeof value.pullRequestTitle === 'string' &&
    typeof value.draft === 'boolean'
    ? {
        commitTitle: value.commitTitle,
        ...(typeof value.commitBody === 'string' ? { commitBody: value.commitBody } : {}),
        pullRequestTitle: value.pullRequestTitle,
        ...(typeof value.pullRequestBody === 'string'
          ? { pullRequestBody: value.pullRequestBody }
          : {}),
        draft: value.draft,
      }
    : undefined;
}

async function interactiveSession(
  host: LocalKouroHost,
  runId: string,
  actor: string,
): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let detached = false;
  const detach = (): void => {
    detached = true;
    terminal.close();
  };
  process.once('SIGINT', detach);
  try {
    for (;;) {
      if (detached) break;
      const stable = await host.worker.runUntilStable(runId);
      if (['succeeded', 'failed', 'cancelled'].includes(stable.state.status)) {
        print({
          runId,
          status: stable.state.status,
          delivery: stable.state.delivery,
        });
        if (
          stable.state.status === 'succeeded' &&
          stable.state.delivery?.commit &&
          stable.state.delivery.publication.status !== 'published'
        ) {
          const answer = (await terminal.question('Publish the reviewed pull request now? [y/N] '))
            .trim()
            .toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            const published = await host.publish(runId);
            if (published.isErr()) {
              process.stdout.write(
                `Publication remains retryable: ${published.error.message}\nRun "kouro publish ${runId}" to retry.\n`,
              );
            } else {
              print(published.value);
            }
          } else {
            process.stdout.write(`Publish later with "kouro publish ${runId}".\n`);
          }
        }
        return;
      }
      if (stable.state.status === 'paused') {
        const action = (await terminal.question('Run paused: [r]esume, [c]ancel, or [d]etach? '))
          .trim()
          .toLowerCase();
        if (action === 'd') break;
        const coordinator = host.coordinatorFor(stable);
        const changed =
          action === 'r'
            ? coordinator.resumeRun(runId, actor, `resume:${randomUUID()}`)
            : coordinator.cancelRun(
                runId,
                actor,
                'cancelled from interactive session',
                `cancel:${randomUUID()}`,
              );
        if (changed.isErr()) throw new Error('Lifecycle decision was stale');
        continue;
      }
      const invocation = stable.state.invocations.find(
        ({ state }) => state === 'waiting_for_approval',
      );
      if (!invocation?.approval) {
        const interrupted = stable.state.invocations.find(({ state }) => state === 'interrupted');
        if (interrupted) {
          const definition = stable.artifact.bundle.nodes.find(
            ({ id }) => id === interrupted.nodeId,
          );
          const canRetry = definition?.recoveryPolicy === 'replay_safe';
          const canSkip = definition?.skipOutcome !== undefined;
          const action = (
            await terminal.question(
              `Invocation ${interrupted.sequence} interrupted: ${canRetry ? '[r]etry, ' : ''}${canSkip ? '[s]kip, ' : ''}[c]ancel, or [d]etach? `,
            )
          )
            .trim()
            .toLowerCase();
          if (action === 'd') break;
          const reason = (await terminal.question('Required reason: ')).trim();
          if (!reason) {
            process.stdout.write('A decision reason is required.\n');
            continue;
          }
          const coordinator = host.coordinatorFor(stable);
          const changed =
            action === 'r' && canRetry
              ? coordinator.retryInvocation(
                  runId,
                  interrupted.sequence,
                  actor,
                  reason,
                  `interactive:retry:${randomUUID()}`,
                )
              : action === 's' && canSkip
                ? coordinator.skipInvocation(
                    runId,
                    interrupted.sequence,
                    actor,
                    reason,
                    `interactive:skip:${randomUUID()}`,
                  )
                : coordinator.cancelRun(runId, actor, reason, `interactive:cancel:${randomUUID()}`);
          if (changed.isErr()) {
            process.stdout.write('Another operator already acted; refreshing.\n');
          }
          continue;
        }
        print({ runId, status: stable.state.status, pendingAction: 'intervention' });
        return;
      }
      const definition = stable.artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      process.stdout.write(
        `\n${invocation.approval.resolvedAction}\nInvocation ${invocation.sequence}\nHEAD ${invocation.approval.repositoryHead}\n`,
      );
      const activation = stable.events.find(
        (event) =>
          event.type === 'invocation.activated' && event.invocationSequence === invocation.sequence,
      );
      const source =
        activation?.type === 'invocation.activated' &&
        activation.sourceInvocationSequence !== undefined
          ? stable.state.invocations.find(
              ({ sequence }) => sequence === activation.sourceInvocationSequence,
            )
          : undefined;
      if (source?.output !== undefined) {
        process.stdout.write(
          `Relevant ${source.nodeId} output:\n${JSON.stringify(source.output, null, 2)}\n`,
        );
      }
      process.stdout.write(
        `Bound artifacts:\n${invocation.approval.artifactChecksums.map((value) => `  ${value}`).join('\n')}\n`,
      );
      let metadata = stable.state.delivery?.proposal?.metadata;
      if (definition?.type === 'delivery_review' && metadata) {
        const artifacts = listArtifacts(
          {
            runs: host.store,
            coordinator: host.coordinatorFor(stable),
          },
          runId,
        );
        const diff = artifacts.isOk()
          ? artifacts.value.find(
              ({ invocationSequence, kind }) =>
                kind === 'git_diff' && invocationSequence === invocation.sequence,
            )
          : undefined;
        if (diff) {
          const content = await getArtifact(
            {
              runs: host.store,
              coordinator: host.coordinatorFor(stable),
              artifacts: new LocalArtifactContentReader(host.paths.artifactDirectory),
            },
            runId,
            diff.id,
          );
          if (content.isOk() && content.value.content) {
            const sections = content.value.content
              .split(/(?=^diff --git )/m)
              .filter((section) => section.startsWith('diff --git '));
            if (sections.length > 0) {
              process.stdout.write(
                `\nChanged files\n${sections
                  .map(
                    (section, index) =>
                      `  ${index + 1}. ${section.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? 'change'}`,
                  )
                  .join('\n')}\n`,
              );
              const selection = (
                await terminal.question('View file number, or press Enter for the full diff: ')
              ).trim();
              const selected = Number(selection);
              process.stdout.write(
                `\nUnified diff\n${
                  Number.isSafeInteger(selected) && selected > 0
                    ? (sections[selected - 1] ?? content.value.content)
                    : content.value.content
                }\n`,
              );
            } else {
              process.stdout.write(`\nUnified diff\n${content.value.content}\n`);
            }
          }
        }
        const commitTitle = await terminal.question(`Commit title [${metadata.commitTitle}]: `);
        const commitBody = await terminal.question(
          `Commit body [${metadata.commitBody ?? 'empty'}]: `,
        );
        const pullRequestTitle = await terminal.question(
          `Pull request title [${metadata.pullRequestTitle}]: `,
        );
        const pullRequestBody = await terminal.question(
          `Pull request body [${metadata.pullRequestBody ?? 'empty'}]: `,
        );
        const draft = await terminal.question(
          `Draft pull request [${metadata.draft ? 'y' : 'n'}]: `,
        );
        metadata = {
          ...metadata,
          ...(commitTitle.trim() ? { commitTitle: commitTitle.trim() } : {}),
          ...(commitBody.trim() ? { commitBody: commitBody.trim() } : {}),
          ...(pullRequestTitle.trim() ? { pullRequestTitle: pullRequestTitle.trim() } : {}),
          ...(pullRequestBody.trim() ? { pullRequestBody: pullRequestBody.trim() } : {}),
          ...(draft.trim() ? { draft: ['y', 'yes'].includes(draft.trim().toLowerCase()) } : {}),
        };
      }
      const repairs = stable.state.delivery?.repairsUsed ?? 0;
      const choices =
        definition?.type === 'delivery_review'
          ? `[a]pprove, ${repairs < 2 ? '[r]equest changes, ' : ''}[f]ail, or [d]etach`
          : '[a]pprove, [r]eject, or [d]etach';
      const action = (await terminal.question(`${choices}? `)).trim().toLowerCase();
      if (action === 'd') break;
      const reason = (await terminal.question('Required reason: ')).trim();
      if (!reason) {
        process.stdout.write('A decision reason is required.\n');
        continue;
      }
      const decision =
        action === 'a'
          ? 'grant'
          : definition?.type === 'delivery_review' && action === 'r' && repairs < 2
            ? 'request_changes'
            : 'reject';
      let binding = invocation.approval;
      const coordinator = host.coordinatorFor(stable);
      if (metadata && stable.state.delivery?.proposal) {
        const updated = host.updateDeliveryMetadata(
          stable,
          invocation.sequence,
          metadata,
          actor,
          `interactive:${randomUUID()}:metadata`,
        );
        if (updated.isErr()) throw new Error(updated.error.message);
        binding =
          updated.value.state.invocations.find(({ sequence }) => sequence === invocation.sequence)
            ?.approval ?? binding;
      }
      const decided = coordinator.decideApproval(
        runId,
        binding,
        decision,
        actor,
        reason,
        `interactive:${randomUUID()}:decision`,
      );
      if (decided.isErr()) {
        process.stdout.write('Another operator already decided; refreshing.\n');
      }
    }
  } catch (cause) {
    if (!detached) throw cause;
  } finally {
    process.removeListener('SIGINT', detach);
    terminal.close();
  }
  process.stdout.write(
    `Detached from ${runId}. Reconnect with "kouro attach ${runId}" or inspect with "kouro status ${runId}".\n`,
  );
}

function harnessOptions(args: readonly string[]): {
  readonly harnesses: readonly string[];
  readonly harnessesByNode: Readonly<Record<string, readonly string[]>>;
} {
  const harnesses: string[] = [];
  const harnessesByNode: Record<string, string[]> = {};
  for (const [index, value] of args.entries()) {
    if (value !== '--harness') continue;
    const selection = required(args[index + 1], '--harness');
    const separator = selection.indexOf('=');
    if (separator < 0) {
      harnesses.push(selection);
      continue;
    }
    const nodeId = required(selection.slice(0, separator), '--harness node');
    const harnessId = required(selection.slice(separator + 1), '--harness id');
    (harnessesByNode[nodeId] ??= []).push(harnessId);
  }
  return { harnesses, harnessesByNode };
}

/** Runs the Kouro command line interface with the provided process arguments. */
export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === 'help') {
    process.stdout.write(`${COMMAND_HELP[args[1] ?? ''] ?? HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${COMMAND_HELP[command] ?? HELP}\n`);
    return 0;
  }

  if (command === 'create') {
    if (required(args[1], 'resource') !== 'adw') {
      throw new Error(`Unknown create resource: ${args[1]}`);
    }
    const template = option(args, '--template') ?? 'feature-development';
    if (!isAdwTemplate(template)) {
      throw new Error(`Unknown ADW template: ${template}. Choose: ${ADW_TEMPLATES.join(', ')}`);
    }
    const result = await createAdw({
      name: required(args[2], 'name'),
      template,
      outputDirectory: resolve(option(args, '--output') ?? resolve(process.cwd(), '.kouro')),
    });
    if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
    print(result.unwrap());
    return 0;
  }

  if (command === 'sandbox') {
    const sandbox = new SandboxRuntimeAgentCommandSandbox();
    const action = required(args[1], 'sandbox action');
    if (action === 'setup') {
      const setup = await sandbox.setup();
      if (setup.isErr()) throw new Error(JSON.stringify(setup.error));
      print(await sandbox.availability());
      return 0;
    }
    if (action === 'status') {
      print(await sandbox.availability());
      return 0;
    }
    throw new Error(`Unknown sandbox action: ${action}`);
  }

  const host = new LocalKouroHost();
  const initialized = await host.initialize();
  if (initialized.isErr())
    throw new Error(`${initialized.error.code}: ${initialized.error.message}`);
  const actor = process.env.USER?.trim() || 'local-operator';
  try {
    if (command === 'ticket') {
      print(await executeTicketCommand(host, args.slice(1), actor));
      return 0;
    }
    if (command === 'eval') {
      print(await executeEvaluationCommand(host, args.slice(1), actor));
      return 0;
    }
    if (command === 'run') {
      const { harnesses, harnessesByNode } = harnessOptions(args);
      const taskFile = option(args, '--task-file');
      const inlineTask = option(args, '--task');
      if (taskFile && inlineTask) {
        throw new Error('Use exactly one of --task and --task-file');
      }
      const task = taskFile ? await readFile(resolve(taskFile), 'utf8') : inlineTask;
      const ticket = option(args, '--ticket');
      const result = await host.create({
        adw: required(args[1], 'adw'),
        repositoryPath: required(option(args, '--repo'), '--repo'),
        ...(task ? { task } : {}),
        ...(ticket ? { ticket } : {}),
        ...(harnesses.length ? { harnesses } : {}),
        ...(Object.keys(harnessesByNode).length ? { harnessesByNode } : {}),
        actor,
        ...(option(args, '--base') ? { base: option(args, '--base') } : {}),
      });
      if (result.isErr()) throw new Error(`${result.error.code}: ${result.error.message}`);
      const created = result.unwrap();
      if (args.includes('--no-interactive') || !process.stdin.isTTY || !process.stdout.isTTY) {
        const aggregate = host.store.loadRun(created.runId);
        const pending = aggregate.isOk()
          ? aggregate.value.state.invocations.find(
              ({ state }) => state === 'waiting_for_approval' || state === 'interrupted',
            )
          : undefined;
        print({
          ...created,
          ...(pending
            ? {
                pendingAction: {
                  invocationSequence: pending.sequence,
                  nodeId: pending.nodeId,
                  state: pending.state,
                },
              }
            : {}),
        });
        return 0;
      }
      await interactiveSession(host, created.runId, actor);
      return 0;
    }
    if (command === 'attach') {
      const runId = required(args[1], 'run-id');
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const loaded = runs.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} was not found`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        print({ runId, status: loaded.value.state.status });
        return 0;
      }
      await interactiveSession(host, runId, actor);
      return 0;
    }
    if (command === 'runs') {
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const result = listRuns({ runs, coordinator: host.coordinator() });
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'status') {
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const result = getRun({ runs, coordinator: host.coordinator() }, required(args[1], 'run-id'));
      if (result.isErr()) throw new Error(result.error.message);
      print(result.unwrap());
      return 0;
    }
    if (command === 'delete') {
      if (!args.includes('--yes')) {
        throw new Error('Run deletion is permanent; pass --yes to confirm');
      }
      const runId = required(args[1], 'run-id');
      const runs = args.includes('--all-repos')
        ? host.store
        : host.runStoreForRepository(resolve(option(args, '--repo') ?? process.cwd()));
      const visible = runs.loadRun(runId);
      if (visible.isErr()) throw new Error(`Run ${runId} was not found in this repository`);
      const deleted = await host.delete(runId);
      if (deleted.isErr()) throw new Error(`${deleted.error.code}: ${deleted.error.message}`);
      print(deleted.unwrap());
      return 0;
    }
    if (command === 'approve' || command === 'reject' || command === 'request-changes') {
      const runId = required(args[1], 'run-id');
      const invocation = Number(required(args[2], 'invocation'));
      const reason = required(option(args, '--reason'), '--reason');
      const loaded = host.store.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} was not found`);
      let binding = loaded
        .unwrap()
        .state.invocations.find(({ sequence }) => sequence === invocation)?.approval;
      if (!binding) throw new Error(`Invocation ${invocation} is not awaiting approval`);
      let current = loaded.unwrap();
      const metadataFile = option(args, '--metadata');
      if (metadataFile) {
        const parsed: unknown = JSON.parse(await readFile(resolve(metadataFile), 'utf8'));
        const metadata = deliveryMetadata(parsed);
        if (!metadata) throw new Error('Metadata file is malformed');
        const updated = host.updateDeliveryMetadata(
          current,
          invocation,
          metadata,
          actor,
          `${command}:metadata:${randomUUID()}`,
        );
        if (updated.isErr()) throw new Error(updated.error.message);
        current = updated.value;
        binding =
          current.state.invocations.find(({ sequence }) => sequence === invocation)?.approval ??
          binding;
      }
      const decided = host
        .coordinatorFor(current)
        .decideApproval(
          runId,
          binding,
          command === 'approve'
            ? 'grant'
            : command === 'request-changes'
              ? 'request_changes'
              : 'reject',
          actor,
          reason,
          `${command}:${randomUUID()}`,
        );
      if (decided.isErr()) throw new Error(`${command} failed`);
      const stable = await host.worker.runUntilStable(runId);
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (command === 'publish') {
      const provider = option(args, '--provider');
      if (provider !== undefined && provider !== 'github' && provider !== 'forgejo') {
        throw new Error('--provider must be github or forgejo');
      }
      const published = await host.publish(
        required(args[1], 'run-id'),
        provider,
        option(args, '--remote') ?? 'origin',
      );
      if (published.isErr()) {
        throw new Error(`${published.error.code}: ${published.error.message}`);
      }
      print(published.value);
      return 0;
    }
    if (['pause', 'resume', 'cancel'].includes(command)) {
      const runId = required(args[1], 'run-id');
      const coordinator = host.coordinator();
      const result =
        command === 'pause'
          ? coordinator.pauseRun(runId, actor, `pause:${randomUUID()}`)
          : command === 'resume'
            ? coordinator.resumeRun(runId, actor, `resume:${randomUUID()}`)
            : coordinator.cancelRun(
                runId,
                actor,
                option(args, '--reason') ?? 'cancelled by operator',
                `cancel:${randomUUID()}`,
              );
      if (result.isErr()) throw new Error(`${command} failed`);
      const stable =
        command === 'resume' ? await host.worker.runUntilStable(runId) : result.unwrap();
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (command === 'steer') {
      const runId = required(args[1], 'run-id');
      const invocation = Number(required(args[2], 'invocation'));
      const message = required(option(args, '--message'), '--message');
      const result = host
        .coordinator()
        .steerInvocation(runId, invocation, actor, message, `steer:${randomUUID()}`);
      if (result.isErr()) throw new Error('steer failed');
      print({ runId, status: result.unwrap().state.status });
      return 0;
    }
    if (['interrupt', 'retry', 'skip'].includes(command)) {
      const runId = required(args[1], 'run-id');
      const invocation = Number(required(args[2], 'invocation'));
      const reason = required(option(args, '--reason'), '--reason');
      const coordinator = host.coordinator();
      const key = `${command}:${randomUUID()}`;
      const result =
        command === 'interrupt'
          ? coordinator.interruptInvocation(runId, invocation, actor, reason, key)
          : command === 'retry'
            ? coordinator.retryInvocation(runId, invocation, actor, reason, key)
            : coordinator.skipInvocation(runId, invocation, actor, reason, key);
      if (result.isErr()) throw new Error(`${command} failed`);
      const stable =
        command === 'retry' || command === 'skip'
          ? await host.worker.runUntilStable(runId)
          : result.unwrap();
      print({ runId, status: stable.state.status });
      return 0;
    }
    if (command === 'diagnostics') {
      print(await host.harnessDiagnostics());
      return 0;
    }
    if (command === 'serve') {
      const port = Number(option(args, '--port') ?? 4317);
      const repositoryPath = args.includes('--all-repos')
        ? undefined
        : resolve(option(args, '--repo') ?? process.cwd());
      const served = await host.serve(port, repositoryPath);
      if (served.isErr()) throw new Error(served.error.message);
      process.stdout.write(
        `Kouro listening on http://localhost:${port} (${repositoryPath ?? 'all repositories'})\n`,
      );
      await new Promise<void>((resolveSignal) => {
        const stop = (): void => {
          served.unwrap().stop();
          resolveSignal();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    host.dispose();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : 'Kouro failed'}\n`);
    process.exitCode = 1;
  }
}
