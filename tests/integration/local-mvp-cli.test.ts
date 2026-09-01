import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import cliPackageManifest from '../../packages/cli/package.json' with { type: 'json' };

import {
  createInlineWorkItem,
  createLocalRequestHandler,
  LocalKouroHost,
  resolveLocalPaths,
  resolveTicketWorkItem,
  type LocalPaths,
} from '@kouro/cli';
import { compileAdwPackage, compileWorkflow } from '@kouro/adw';
import {
  type AgentHarness,
  type HarnessError,
  type HarnessExecution,
  type HarnessExecutionRequest,
  RunStoreErrorKind,
  ScriptedFakeTicketProvider,
  type TicketProvider,
} from '@kouro/executors';
import { ScriptedFakeHarness } from '@kouro/harnesses';
import { ok, type Result } from '@usersatoshi/results';
import { executeEvaluationCommand } from '../../packages/cli/src/evaluation-command.ts';

class BlockingHarness implements AgentHarness {
  readonly id = 'blocking';
  readonly started: Promise<void>;
  request: HarnessExecutionRequest | undefined;
  private resolveStarted: (() => void) | undefined;
  private resolveExecution: (() => void) | undefined;

  constructor() {
    this.started = new Promise((resolveStarted) => {
      this.resolveStarted = resolveStarted;
    });
  }

  async execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    this.request = request;
    await request.onTranscriptChunk?.(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'reasoning-1',
          type: 'reasoning',
          text: 'Inspecting the active worktree.',
        },
      })}\n`,
    );
    this.resolveStarted?.();
    await new Promise<void>((resolveExecution) => {
      this.resolveExecution = resolveExecution;
    });
    return ok({
      output: { summary: 'Lease-safe plan', steps: ['Observe without interruption'] },
      transcript: 'completed after observer started',
    });
  }

  resume(
    request: HarnessExecutionRequest,
    _token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.execute(request);
  }

  release(): void {
    this.resolveExecution?.();
  }
}

async function process(
  command: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await process(['git', 'init', '--initial-branch=main'], path);
  await process(['git', 'config', 'user.name', 'Fixture'], path);
  await process(['git', 'config', 'user.email', 'fixture@example.test'], path);
  await writeFile(
    resolve(path, 'package.json'),
    `${JSON.stringify(
      {
        scripts: {
          lint: 'true',
          format: 'true',
          test: 'bun test',
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(path, 'fixture.test.ts'),
    "import { expect, test } from 'bun:test';\ntest('fixture', () => expect(1).toBe(1));\n",
  );
  await process(['git', 'add', '.'], path);
  await process(['git', 'commit', '-m', 'fixture'], path);
}

function localPaths(root: string): LocalPaths {
  const dataDirectory = resolve(root, 'data');
  return {
    dataDirectory,
    configDirectory: resolve(root, 'config'),
    databasePath: resolve(dataDirectory, 'kouro.sqlite'),
    artifactDirectory: resolve(dataDirectory, 'artifacts'),
    worktreeDirectory: resolve(dataDirectory, 'worktrees'),
  };
}

describe('M7 runnable local MVP and operator CLI', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('legacy Kairo path overrides continue to resolve existing local data', () => {
    expect(
      resolveLocalPaths({
        KAIRO_DATA_DIR: '/tmp/legacy-kairo-data',
        KAIRO_CONFIG_DIR: '/tmp/legacy-kairo-config',
      }),
    ).toEqual({
      dataDirectory: '/tmp/legacy-kairo-data',
      configDirectory: '/tmp/legacy-kairo-config',
      databasePath: '/tmp/legacy-kairo-data/kairo.sqlite',
      artifactDirectory: '/tmp/legacy-kairo-data/artifacts',
      worktreeDirectory: '/tmp/legacy-kairo-data/worktrees',
    });
  });

  test('fresh checkout exposes stable help and version through the binary entrypoint', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const help = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), '--help'],
      root,
    );
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(
      'kouro create adw <name> [--template <template>] [--output <directory>]',
    );
    expect(help.stdout).toContain('feature-development, hotfix, bug-fix, chore');
    expect(help.stdout).toContain('kouro run <adw> --repo <path>');
    expect(help.stdout).toContain('--ticket <provider:reference>');
    expect(help.stdout).toContain('kouro pause|resume|cancel <run-id>');
    expect(help.stdout).toContain('attach          Reconnect to an interactive run session');
    expect(help.stdout).toContain('publish         Push a delivered branch');
    expect(help.stdout).toContain('eval            List datasets, evaluate runs');

    const runHelp = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), 'help', 'run'],
      root,
    );
    expect(runHelp.exitCode).toBe(0);
    expect(runHelp.stdout).toContain('Usage:\n  kouro run <adw>');
    expect(runHelp.stdout).toContain('Examples:');

    const evaluationHelp = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), 'help', 'eval'],
      root,
    );
    expect(evaluationHelp.exitCode).toBe(0);
    expect(evaluationHelp.stdout).toContain('kouro eval run <run-id>');
    expect(evaluationHelp.stdout).toContain('kouro eval prefer <experiment-id>');

    const version = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), '--version'],
      root,
    );
    expect(version).toEqual({ exitCode: 0, stdout: `${cliPackageManifest.version}\n`, stderr: '' });
  });

  test('evaluation command lists checked-in repository datasets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-evaluation-cli-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    const evaluationDirectory = resolve(repository, '.kouro', 'evaluations');
    await mkdir(evaluationDirectory, { recursive: true });
    await writeFile(
      resolve(evaluationDirectory, 'regression.json'),
      JSON.stringify({
        schemaVersion: '1',
        id: 'cli-regression',
        version: '1.0.0',
        cases: [
          {
            id: 'case-a',
            workItem: { title: 'Exercise CLI dataset loading' },
            expectations: [{ type: 'run_status', value: 'succeeded' }],
          },
        ],
      }),
    );
    const host = new LocalKouroHost(localPaths(root), [], []);
    expect((await host.initialize()).isOk()).toBe(true);
    try {
      expect(
        await executeEvaluationCommand(host, ['datasets', '--repo', repository], 'tester'),
      ).toEqual([
        expect.objectContaining({
          id: 'cli-regression',
          version: '1.0.0',
          caseIds: ['case-a'],
        }),
      ]);
    } finally {
      host.dispose();
    }
  });

  test('package launcher exposes the CLI and packaged templates', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(root, '.kouro-distribution-'));
    roots.push(output);

    const launcher = resolve(root, 'bin', 'kouro.ts');
    const help = await process(['bun', 'run', launcher, '--help'], root);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(`Kouro ${cliPackageManifest.version}`);

    const created = await process(
      ['bun', 'run', launcher, 'create', 'adw', 'packaged-cli', '--output', output],
      root,
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      name: 'packaged-cli',
      template: 'feature-development',
      path: resolve(output, 'packaged-cli'),
    });
    expect((await compileAdwPackage(resolve(output, 'packaged-cli'))).isOk()).toBe(true);
  });

  test('create adw renders every bundled template as a compilable package', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(root, '.kouro-adw-templates-'));
    roots.push(output);
    const templates = ['feature-development', 'hotfix', 'bug-fix', 'chore'] as const;

    for (const template of templates) {
      const name = `sample-${template}`;
      const created = await process(
        [
          'bun',
          'run',
          resolve(root, 'packages', 'cli', 'src', 'main.ts'),
          'create',
          'adw',
          name,
          '--template',
          template,
          '--output',
          output,
        ],
        root,
      );
      expect(created.exitCode).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({
        name,
        template,
        path: resolve(output, name),
      });

      const manifest = JSON.parse(await readFile(resolve(output, name, 'manifest.json'), 'utf8'));
      expect(manifest.id).toBe(name);
      expect(manifest.name).toBe(
        name
          .split('-')
          .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
          .join(' '),
      );
      const entrypoint = await readFile(resolve(output, name, 'kouro.adw.ts'), 'utf8');
      expect(entrypoint).toContain("WorkflowBuilder } from '@kouro/adw'");
      expect(entrypoint).toContain('workflow.startAt(');
      expect(entrypoint).toContain(".on('success').to(");
      expect(entrypoint).toContain('export default workflow.build()');
      expect(await Bun.file(resolve(output, name, 'kouro-sdk.ts')).exists()).toBe(false);
      const compiled = await compileAdwPackage(resolve(output, name));
      expect(compiled.isOk()).toBe(true);
      if (compiled.isOk()) {
        const bundle = compiled.unwrap().bundle;
        expect(bundle.nodes).toContainEqual(
          expect.objectContaining({
            id: template === 'feature-development' ? 'review' : 'deliveryMetadata',
            outputSchema: './schemas/delivery-metadata.schema.ts',
          }),
        );
        if (template === 'chore') {
          expect(bundle.subagents).toBeUndefined();
        } else {
          const planningNode = {
            'feature-development': 'plan',
            hotfix: 'assess',
            'bug-fix': 'reproduce',
          }[template];
          expect(bundle.nodes).toContainEqual(
            expect.objectContaining({
              id: planningNode,
              allowedSubagents: ['repositoryScout', 'testScout'],
            }),
          );
          expect(bundle.subagents).toEqual([
            {
              id: 'repositoryScout',
              role: 'repository-scout',
              prompt: './prompts/repository-scout.md',
              outputSchema: './schemas/scout.schema.ts',
              capabilities: ['repository.read'],
              maxInvocations: 2,
              maxConcurrent: 2,
            },
            {
              id: 'testScout',
              role: 'test-scout',
              prompt: './prompts/test-scout.md',
              outputSchema: './schemas/scout.schema.ts',
              capabilities: ['repository.read'],
              maxInvocations: 2,
              maxConcurrent: 2,
            },
          ]);
          expect(bundle.schemas?.['./schemas/scout.schema.ts']).toEqual(
            expect.objectContaining({
              required: ['summary', 'findings'],
            }),
          );
        }
        expect(bundle.schemas?.['./schemas/delivery-metadata.schema.ts']).toEqual(
          expect.objectContaining({
            required: ['deliveryMetadata'],
            properties: expect.objectContaining({
              deliveryMetadata: expect.objectContaining({
                additionalProperties: false,
                required: ['commitTitle', 'pullRequestTitle', 'draft'],
              }),
            }),
          }),
        );
        for (const [nodeId, command] of [
          ['lint', 'bun run lint'],
          ['format', 'bun run format'],
          ['typecheck', 'bun run typecheck'],
          ['test', 'bun test --pass-with-no-tests'],
        ] as const) {
          expect(bundle.nodes).toContainEqual(
            expect.objectContaining({
              id: nodeId,
              type: 'command',
              command,
              capabilities: ['repository.read', 'terminal.execute'],
              recoveryPolicy: 'replay_safe',
            }),
          );
        }
      }
      if (template === 'chore' && compiled.isOk()) {
        const bundle = compiled.unwrap().bundle;
        expect(bundle.counterLimits).toEqual({
          deliveryRepairs: 2,
          formatRepairs: 3,
          lintRepairs: 3,
          testRepairs: 3,
          typecheckRepairs: 3,
        });
        expect(bundle.runLimits?.maxNodeInvocations).toBe(20);
        expect(bundle.entryNodeId).toBe('dependencies');
        expect(bundle.nodes).toContainEqual(
          expect.objectContaining({
            id: 'dependencies',
            type: 'command',
            command: 'bun install --frozen-lockfile',
            capabilities: ['repository.read', 'terminal.execute'],
            recoveryPolicy: 'replay_safe',
          }),
        );
        expect(bundle.nodes).toContainEqual(
          expect.objectContaining({
            id: 'implement',
            capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
          }),
        );
        expect(bundle.transitions).toContainEqual({
          id: 'dependencies.success.implement',
          from: { nodeId: 'dependencies', outcome: 'success' },
          toNodeId: 'implement',
        });
        expect(bundle.transitions).toContainEqual({
          id: 'dependencies.failure.failed',
          from: { nodeId: 'dependencies', outcome: 'failure' },
          toNodeId: 'failed',
        });
        expect(bundle.transitions).toContainEqual({
          id: 'lint.failure.implement',
          from: { nodeId: 'lint', outcome: 'failure' },
          toNodeId: 'implement',
          condition: {
            op: 'lt',
            left: { scope: 'counter', name: 'lintRepairs' },
            right: 3,
          },
          increment: 'lintRepairs',
        });
        expect(bundle.transitions).toContainEqual({
          id: 'lint.failure.failed',
          from: { nodeId: 'lint', outcome: 'failure' },
          toNodeId: 'failed',
          default: true,
        });
        expect(bundle.transitions).toContainEqual({
          id: 'delivery.changes_requested.failed',
          from: { nodeId: 'delivery', outcome: 'changes_requested' },
          toNodeId: 'failed',
          default: true,
        });
      }
    }
  });

  test('a generated SDK workflow can be extended with another node and transitions', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(root, '.kouro-adw-extension-'));
    roots.push(output);
    const created = await process(
      [
        'bun',
        'run',
        resolve(root, 'packages', 'cli', 'src', 'main.ts'),
        'create',
        'adw',
        'extended-chore',
        '--template',
        'chore',
        '--output',
        output,
      ],
      root,
    );
    expect(created.exitCode).toBe(0);
    const packageDirectory = resolve(output, 'extended-chore');
    const entrypointPath = resolve(packageDirectory, 'kouro.adw.ts');
    const entrypoint = await readFile(entrypointPath, 'utf8');
    const extended = entrypoint
      .replace(
        "const complete = workflow.complete('complete');",
        `const inspect = workflow.command('inspect', {
  command: 'git diff --check',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const complete = workflow.complete('complete');`,
      )
      .replace(
        "test.on('success').to(deliveryMetadata);",
        `test.on('success').to(inspect);
inspect.on('success').to(deliveryMetadata);
inspect.on('failure').to(failed);`,
      );
    await writeFile(entrypointPath, extended);

    const compiled = await compileAdwPackage(packageDirectory);

    expect(compiled.isOk()).toBe(true);
    if (compiled.isOk()) {
      expect(compiled.unwrap().bundle.nodes.some(({ id }) => id === 'inspect')).toBe(true);
      expect(
        compiled.unwrap().bundle.transitions.some(({ id }) => id === 'test.success.inspect'),
      ).toBe(true);
    }
  });

  test('create adw rejects invalid names and existing target folders', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(tmpdir(), 'kouro-adw-reject-'));
    roots.push(output);
    const command = [
      'bun',
      'run',
      resolve(root, 'packages', 'cli', 'src', 'main.ts'),
      'create',
      'adw',
    ];

    const invalid = await process([...command, '../unsafe', '--output', output], root);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('invalid_adw_name');

    const first = await process([...command, 'existing', '--output', output], root);
    expect(first.exitCode).toBe(0);
    const second = await process([...command, 'existing', '--output', output], root);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('Target already exists');
  });

  test('create adw defaults to the current repository .kouro directory', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const repository = await mkdtemp(resolve(tmpdir(), 'kouro-adw-default-'));
    roots.push(repository);

    const created = await process(
      [
        'bun',
        'run',
        resolve(root, 'packages', 'cli', 'src', 'main.ts'),
        'create',
        'adw',
        'default-location',
        '--template',
        'chore',
      ],
      repository,
    );

    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).path).toBe(
      await realpath(resolve(repository, '.kouro', 'default-location')),
    );
    expect(
      await readFile(resolve(repository, '.kouro', 'default-location', 'manifest.json'), 'utf8'),
    ).toContain('"id": "default-location"');
  });

  test('serve router mounts JSON API under /api before the SPA fallback', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m7-serve-'));
    roots.push(root);
    const host = new LocalKouroHost(localPaths(root), []);
    expect((await host.initialize()).isOk()).toBe(true);
    const repositoryRoot = resolve(import.meta.dir, '..', '..');
    const handle = createLocalRequestHandler(
      host.app(),
      resolve(repositoryRoot, 'packages', 'web', 'dist'),
    );
    try {
      const response = await handle(new Request('http://kouro.local/api/runs'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual([]);

      const page = await handle(new Request('http://kouro.local/'));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<!doctype html>');
    } finally {
      host.dispose();
    }
  });

  test('a repository-scoped app exposes its launch target before the first run', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-web-launch-target-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const host = new LocalKouroHost(localPaths(root), []);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const response = await host
        .app(repository)
        .handle(new Request('http://kouro.local/repositories'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        { id: expect.stringMatching(/^repo-/), path: repository },
      ]);
    } finally {
      host.dispose();
    }
  });

  test('web run creation returns while the local worker continues in the background', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-web-background-run-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const harness = new BlockingHarness();
    const host = new LocalKouroHost(localPaths(root), [harness]);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        host.app(repository).handle(
          new Request('http://kouro.local/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              adw: 'feature-development',
              repositoryPath: repository,
              task: 'Return before the blocking planner completes.',
              harnesses: ['blocking'],
              reasoningEffort: 'high',
              actor: 'web-user',
            }),
          }),
        ),
        new Promise<Response>((_resolveResponse, rejectResponse) => {
          timeout = setTimeout(
            () => rejectResponse(new Error('Web run creation did not return')),
            1_000,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(response.status).toBe(200);
      const created: { readonly runId: string; readonly status: string } = await response.json();
      expect(created).toEqual({
        runId: expect.stringMatching(/^run-/),
        status: 'running',
      });
      await harness.started;
      expect(harness.request?.reasoningEffort).toBe('high');
      harness.release();
      await host.worker.runUntilStable(created.runId);
    } finally {
      harness.release();
      host.dispose();
    }
  });

  test('a repository-scoped app does not expose runs from another repository', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-repository-scope-'));
    roots.push(root);
    const firstRepository = resolve(root, 'first');
    const secondRepository = resolve(root, 'second');
    await createRepository(firstRepository);
    await createRepository(secondRepository);
    const host = new LocalKouroHost(localPaths(root), [
      new ScriptedFakeHarness('fake-0', [
        {
          output: { summary: 'First plan', steps: ['Wait for approval'] },
          transcript: 'planned first',
        },
      ]),
      new ScriptedFakeHarness('fake-1', [
        {
          output: { summary: 'Second plan', steps: ['Wait for approval'] },
          transcript: 'planned second',
        },
      ]),
    ]);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const first = await host.create({
        adw: 'feature-development',
        repositoryPath: firstRepository,
        task: 'First repository task',
        harnesses: ['fake-0'],
        actor: 'operator',
      });
      const second = await host.create({
        adw: 'feature-development',
        repositoryPath: secondRepository,
        task: 'Second repository task',
        harnesses: ['fake-1'],
        actor: 'operator',
      });
      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);

      const app = host.app(firstRepository);
      const listed = await app.handle(new Request('http://kouro.local/runs'));
      const body: readonly { readonly id: string; readonly repositoryPath: string }[] =
        await listed.json();
      expect(body).toHaveLength(1);
      expect(body[0]?.id).toBe(first.unwrap().runId);
      expect(body[0]?.repositoryPath).toBe(await realpath(firstRepository));

      const hidden = await app.handle(
        new Request(`http://kouro.local/runs/${second.unwrap().runId}`),
      );
      expect(hidden.status).toBe(404);
      const hiddenControl = await app.handle(
        new Request(`http://kouro.local/runs/${second.unwrap().runId}/pause`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: 'operator',
            idempotencyKey: 'pause:hidden-run',
          }),
        }),
      );
      expect(hiddenControl.status).toBe(404);
    } finally {
      host.dispose();
    }
  });

  test('a serving observer does not recover or interrupt a CLI-owned attempt', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-worker-lease-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const paths = localPaths(root);
    const harness = new BlockingHarness();
    const owner = new LocalKouroHost(paths, [harness]);
    const observer = new LocalKouroHost(paths, []);
    try {
      expect((await owner.initialize()).isOk()).toBe(true);
      const creation = owner.create({
        adw: 'feature-development',
        repositoryPath: repository,
        task: 'Keep this attempt alive while serve starts.',
        harnesses: ['blocking'],
        actor: 'operator',
      });
      await harness.started;
      const runId = owner.store.listRuns().unwrap()[0]?.runId;
      if (!runId) throw new Error('The active run was not persisted');

      expect((await observer.initialize()).isOk()).toBe(true);
      observer.worker.start();
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      const observed = observer.store.loadRun(runId).unwrap();
      expect(observed.events.some(({ type }) => type === 'attempt.interrupted')).toBe(false);
      expect(
        observed.state.invocations.some(({ attempts }) =>
          attempts.some(({ state }) => state === 'running'),
        ),
      ).toBe(true);
      const activeInvocation = observed.state.invocations.find(({ attempts }) =>
        attempts.some(({ state }) => state === 'running'),
      );
      if (!activeInvocation) throw new Error('The active invocation was not projected');
      const activityResponse = await observer
        .app(repository)
        .handle(
          new Request(
            `http://kouro.local/runs/${runId}/invocations/${activeInvocation.sequence}/activity`,
          ),
        );
      const activityBody = await activityResponse.json();
      expect({ status: activityResponse.status, body: activityBody }).toEqual({
        status: 200,
        body: expect.objectContaining({
          runId,
          invocationSequence: activeInvocation.sequence,
          harnessId: 'blocking',
          complete: false,
          transcript: expect.stringContaining('Inspecting the active worktree.'),
        }),
      });

      harness.release();
      expect((await creation).isOk()).toBe(true);
    } finally {
      harness.release();
      observer.dispose();
      owner.dispose();
    }
  });

  test('deletion rejects an active run and removes a cancelled run', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-run-deletion-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const host = new LocalKouroHost(localPaths(root), [
      new ScriptedFakeHarness('fake', [
        {
          output: { summary: 'Plan to delete', steps: ['Wait for cancellation'] },
          transcript: 'planned',
        },
      ]),
    ]);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const created = await host.create({
        adw: 'feature-development',
        repositoryPath: repository,
        task: 'Create a disposable run.',
        harnesses: ['fake'],
        actor: 'operator',
      });
      const runId = created.unwrap().runId;
      const app = host.app(repository);

      const activeDeletion = await app.handle(
        new Request(`http://kouro.local/runs/${runId}`, { method: 'DELETE' }),
      );
      expect(activeDeletion.status).toBe(409);

      const cancelled = host
        .coordinatorFor(host.store.loadRun(runId).unwrap())
        .cancelRun(runId, 'operator', 'test cleanup', 'cancel:delete-test');
      expect(cancelled.isOk()).toBe(true);
      const deleted = await app.handle(
        new Request(`http://kouro.local/runs/${runId}`, { method: 'DELETE' }),
      );
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ runId, deleted: true });
      const missing = host.store.loadRun(runId);
      expect(missing.isErr()).toBe(true);
      if (missing.isErr()) expect(missing.error.kind).toBe(RunStoreErrorKind.RunNotFound);
    } finally {
      host.dispose();
    }
  });

  test('local host diagnoses every supported harness runtime', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m7-diagnostics-'));
    roots.push(root);
    const host = new LocalKouroHost(localPaths(root));
    try {
      expect((await host.harnessDiagnostics()).map(({ id }) => id)).toEqual([
        'codex',
        'claude-code',
        'opencode',
        'pi',
      ]);
    } finally {
      host.dispose();
    }
  });

  test('run creation rejects a harness route that is not an agent node', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m7-routing-'));
    roots.push(root);
    const host = new LocalKouroHost(localPaths(root), []);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const result = await host.create({
        adw: 'feature-development',
        repositoryPath: '/not-used-for-invalid-routing',
        harnessesByNode: { missing: ['opencode'] },
        actor: 'operator',
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.code).toBe('invalid_harness_route');
    } finally {
      host.dispose();
    }
  });

  test('feature development requires one durable work item before repository side effects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m8-required-'));
    roots.push(root);
    const host = new LocalKouroHost(localPaths(root), []);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const repository = resolve(root, 'repository-that-does-not-exist');
      const missing = await host.create({
        adw: 'feature-development',
        repositoryPath: repository,
        actor: 'operator',
      });
      expect(missing.isErr()).toBe(true);
      if (missing.isErr()) expect(missing.error.code).toBe('work_item_required');

      const unknownProvider = await host.create({
        adw: 'feature-development',
        repositoryPath: repository,
        ticket: 'linear:ENG-123',
        actor: 'operator',
      });
      expect(unknownProvider.isErr()).toBe(true);
      if (unknownProvider.isErr()) {
        expect(unknownProvider.error.code).toBe('ticket_provider_not_configured');
      }
      expect(await Bun.file(repository).exists()).toBe(false);
    } finally {
      host.dispose();
    }
  });

  test('work-item checksums are stable across insignificant provider ordering', async () => {
    const inline = createInlineWorkItem('  Implement the ticket input.  ').unwrap();
    expect(createInlineWorkItem('Implement the ticket input.').unwrap().checksum).toBe(
      inline.checksum,
    );
    let providerCalls = 0;
    const provider: TicketProvider = {
      id: 'kanban',
      resolve(reference) {
        providerCalls += 1;
        return Promise.resolve(
          ok({
            reference,
            revision: '7',
            title: 'Stable snapshot',
            description: 'Normalize provider data.',
            acceptanceCriteria: ['First', 'Second'],
            labels: providerCalls === 1 ? ['runtime', 'feature'] : ['feature', 'runtime'],
          }),
        );
      },
    };
    const providers = new Map([[provider.id, provider]]);
    const first = await resolveTicketWorkItem('kanban:ENG-123', providers);
    const second = await resolveTicketWorkItem('kanban:ENG-123', providers);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(first.unwrap().labels).toEqual(['feature', 'runtime']);
    expect(second.unwrap().labels).toEqual(['feature', 'runtime']);
    expect(second.unwrap().checksum).toBe(first.unwrap().checksum);
  });

  test('ticket resolution snapshots and delivers one immutable work item to the agent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m8-ticket-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const paths = localPaths(root);
    const harness = new ScriptedFakeHarness('fake', [
      {
        output: { summary: 'Plan ticket', steps: ['Implement', 'Test'] },
        transcript: 'planned',
      },
    ]);
    const provider = new ScriptedFakeTicketProvider('kanban', [
      {
        reference: 'ENG-123',
        revision: '42',
        url: 'https://kanban.example.test/tickets/ENG-123',
        title: 'Add durable ticket input',
        description: 'Make the requested change available to every agent.',
        acceptanceCriteria: ['Planner receives the ticket', 'Restart does not refetch'],
        labels: ['runtime', 'feature'],
      },
    ]);
    const host = new LocalKouroHost(paths, [harness], [provider]);
    let runId = '';
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const created = await host.create({
        adw: 'feature-development',
        repositoryPath: repository,
        ticket: 'kanban:ENG-123',
        harnesses: ['fake'],
        actor: 'operator',
      });
      expect(created.isOk()).toBe(true);
      runId = created.unwrap().runId;
      expect(provider.references).toEqual(['ENG-123']);
      const aggregate = host.store.loadRun(runId).unwrap();
      expect(aggregate.state.configuration.workItem).toMatchObject({
        schemaVersion: 1,
        kind: 'ticket',
        provider: 'kanban',
        reference: 'ENG-123',
        revision: '42',
        title: 'Add durable ticket input',
      });
      expect(aggregate.state.configuration.workItem).toHaveProperty(
        'checksum',
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      );
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.request.prompt).toContain('Immutable work item for this run');
      expect(harness.calls[0]?.request.prompt).toContain('Planner receives the ticket');
    } finally {
      host.dispose();
    }
    const restarted = new LocalKouroHost(paths, [new ScriptedFakeHarness('fake', [])], [provider]);
    try {
      expect((await restarted.initialize()).isOk()).toBe(true);
      expect(restarted.store.loadRun(runId).isOk()).toBe(true);
      expect(provider.references).toEqual(['ENG-123']);
    } finally {
      restarted.dispose();
    }
  });

  test('packaged workflow survives restart and reaches a merge-ready branch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m7-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const paths = localPaths(root);
    const harness = new ScriptedFakeHarness('fake', [
      {
        output: { summary: 'Plan fixture', steps: ['Implement', 'Test'] },
        transcript: 'planned',
      },
      {
        output: { summary: 'Implemented fixture', changedFiles: [] },
        transcript: 'implemented',
      },
      {
        output: { approved: true, findings: [] },
        transcript: 'reviewed',
      },
    ]);
    const first = new LocalKouroHost(paths, [harness]);
    expect((await first.initialize()).isOk()).toBe(true);
    const created = await first.create({
      adw: 'feature-development',
      repositoryPath: repository,
      task: 'Implement and validate the fixture change.',
      harnesses: ['fake'],
      actor: 'operator',
    });
    expect(created.isOk()).toBe(true);
    const runId = created.unwrap().runId;
    let aggregate = first.store.loadRun(runId).unwrap();
    expect(aggregate.state.status).toBe('waiting_for_approval');
    const planApproval = aggregate.state.invocations.find(
      ({ state }) => state === 'waiting_for_approval',
    );
    expect(planApproval?.approval).toBeDefined();
    if (!planApproval?.approval) throw new Error('Plan approval was not requested');

    const pauseResponse = await first.app().handle(
      new Request(`http://kouro.local/runs/${runId}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'operator',
          idempotencyKey: 'pause:plan-approval',
        }),
      }),
    );
    expect(pauseResponse.status).toBe(200);
    const paused = first.store.loadRun(runId).unwrap();
    expect(paused.state.status).toBe('paused');
    const resumed = first
      .coordinatorFor(paused)
      .resumeRun(runId, 'operator', 'resume:plan-approval');
    expect(resumed.unwrap().state.status).toBe('waiting_for_approval');
    const approved = first
      .coordinatorFor(resumed.unwrap())
      .decideApproval(
        runId,
        planApproval.approval,
        'grant',
        'operator',
        'plan accepted',
        'approve:plan',
      );
    expect(approved.isOk()).toBe(true);
    aggregate = await first.worker.runUntilStable(runId);
    expect(aggregate.state.status).toBe('waiting_for_approval');
    expect(harness.calls).toHaveLength(3);
    expect(
      harness.calls.every(({ request }) =>
        request.prompt.includes('Implement and validate the fixture change.'),
      ),
    ).toBe(true);
    first.dispose();

    const restarted = new LocalKouroHost(paths, [new ScriptedFakeHarness('fake', [])]);
    expect((await restarted.initialize()).isOk()).toBe(true);
    aggregate = restarted.store.loadRun(runId).unwrap();
    const deliveryApproval = aggregate.state.invocations.find(
      ({ state }) => state === 'waiting_for_approval',
    );
    expect(deliveryApproval?.approval).toBeDefined();
    if (!deliveryApproval?.approval) throw new Error('Delivery approval was not requested');
    const delivered = restarted
      .coordinatorFor(aggregate)
      .decideApproval(
        runId,
        deliveryApproval.approval,
        'grant',
        'operator',
        'delivery accepted',
        'approve:delivery',
      );
    expect(delivered.isOk()).toBe(true);
    aggregate = await restarted.worker.runUntilStable(runId);
    expect(aggregate.state.status).toBe('succeeded');
    expect(aggregate.state.artifacts?.map(({ kind }) => kind).toSorted()).toEqual([
      'delivery_proposal',
      'git_diff',
      'git_status',
    ]);
    const branch = aggregate.state.configuration.deliveryBranch;
    if (typeof branch !== 'string') throw new Error('Delivery branch was not snapshotted');
    const branchCommit = await process(['git', 'rev-parse', branch], repository);
    expect(branchCommit.exitCode).toBe(0);
    expect(aggregate.state.delivery?.commit).toBe(branchCommit.stdout.trim());
    expect(branchCommit.stdout.trim()).not.toBe(aggregate.state.startingCommit);
    const commitTitle = await process(['git', 'log', '-1', '--format=%s', branch], repository);
    expect(commitTitle.stdout.trim()).toBe('Implement and validate the fixture change.');

    const appRun = await restarted.app().handle(new Request(`http://kouro.local/runs/${runId}`));
    expect(appRun.status).toBe(200);
    expect((await appRun.json()).status).toBe('succeeded');
    restarted.dispose();
  });

  test('interrupt, retry, and policy-eligible skip are durable bound events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-m7-controls-'));
    roots.push(root);
    const host = new LocalKouroHost(localPaths(root), []);
    expect((await host.initialize()).isOk()).toBe(true);
    const commandWorkflow = compileWorkflow({
      manifest: { id: 'controls', version: '1.0.0' },
      semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
      entryNodeId: 'command',
      nodes: [
        {
          id: 'command',
          type: 'command',
          command: 'true',
          recoveryPolicy: 'replay_safe',
          skipOutcome: 'success',
        },
        { id: 'complete', type: 'complete' },
      ],
      transitions: [
        {
          id: 'command.success.complete',
          from: { nodeId: 'command', outcome: 'success' },
          toNodeId: 'complete',
        },
      ],
      counterLimits: {},
    });
    expect(commandWorkflow.isOk()).toBe(true);
    const coordinator = host.coordinator(root);
    let commandRun = coordinator
      .createRun({
        runId: 'interrupt-run',
        artifact: commandWorkflow.unwrap(),
        startingCommit: 'fixture',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    commandRun = (await coordinator.advance(commandRun.runId)).unwrap();
    commandRun = host.store
      .appendEvent({
        runId: commandRun.runId,
        expectedSequence: commandRun.nextEventSequence,
        idempotencyKey: 'start',
        event: {
          type: 'attempt.started',
          invocationSequence: 1,
          attemptNumber: 1,
        },
      })
      .unwrap();
    commandRun = coordinator
      .interruptInvocation(commandRun.runId, 1, 'operator', 'stop process', 'interrupt')
      .unwrap();
    expect(commandRun.state.invocations[0]?.state).toBe('interrupted');
    commandRun = coordinator
      .retryInvocation(commandRun.runId, 1, 'operator', 'safe replay', 'retry')
      .unwrap();
    expect(commandRun.state.invocations[0]?.state).toBe('pending');
    commandRun = (await coordinator.advance(commandRun.runId)).unwrap();
    expect(commandRun.state.invocations[0]?.attempts).toHaveLength(2);
    expect(commandRun.events.map(({ type }) => type).slice(-3)).toEqual([
      'invocation.retry_requested',
      'attempt.started',
      'invocation.completed',
    ]);

    let skipRun = coordinator
      .createRun({
        runId: 'skip-run',
        artifact: commandWorkflow.unwrap(),
        startingCommit: 'fixture',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    skipRun = (await coordinator.advance(skipRun.runId)).unwrap();
    skipRun = coordinator
      .skipInvocation(skipRun.runId, 1, 'operator', 'declared success', 'skip')
      .unwrap();
    expect(skipRun.state.invocations[0]?.outcome).toBe('success');
    const skipped = skipRun.events.at(-1);
    expect(skipped?.type).toBe('invocation.skipped');
    if (skipped?.type !== 'invocation.skipped') throw new Error('Skip event was not recorded');
    expect(skipped.binding).toEqual({
      workflowChecksum: commandWorkflow.unwrap().checksum,
      invocationSequence: 1,
      artifactChecksums: [],
      selectedOutcome: 'success',
      repositoryHead: 'fixture',
    });
    host.dispose();
  });
});
