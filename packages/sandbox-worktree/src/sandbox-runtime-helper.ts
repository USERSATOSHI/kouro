#!/usr/bin/env bun

import { resolve } from 'node:path';

import {
  installWindowsSandboxAsync,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';

interface HelperRequest {
  readonly command: string;
  readonly workingDirectory: string;
  readonly writable: boolean;
  readonly network: boolean;
  readonly environment: Readonly<Record<string, string>>;
}

const sensitiveDirectories = ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config/gcloud'];
const sensitiveFiles = ['.npmrc', '.pypirc', '.netrc', '.git-credentials'];

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Sandbox helper failed';
}

function sensitivePaths(environment: Readonly<Record<string, string>>): string[] {
  const home = environment.HOME ?? environment.USERPROFILE;
  return home
    ? [...sensitiveDirectories, ...sensitiveFiles].map((suffix) => resolve(home, suffix))
    : [];
}

function sensitiveEnvironmentVariables(
  environment: Readonly<Record<string, string>>,
): { readonly name: string; readonly mode: 'deny' }[] {
  return Object.keys(environment)
    .filter((name) => /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name))
    .map((name) => ({ name, mode: 'deny' as const }));
}

export function sandboxRuntimeConfig(request: HelperRequest): SandboxRuntimeConfig {
  const protectedPaths = sensitivePaths(request.environment);
  return {
    network: {
      allowedDomains: request.network ? ['*'] : [],
      deniedDomains: request.network ? [] : ['*'],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      allowRead: [request.workingDirectory],
      denyRead: protectedPaths,
      allowWrite: request.writable ? [request.workingDirectory] : [],
      denyWrite: request.writable ? protectedPaths : [request.workingDirectory, ...protectedPaths],
      allowGitConfig: false,
    },
    credentials: {
      files: protectedPaths.map((path) => ({ path, mode: 'deny' as const })),
      envVars: sensitiveEnvironmentVariables(request.environment),
    },
    git: { safeDirectories: [request.workingDirectory] },
  };
}

function decodeRequest(value: string | undefined): HelperRequest {
  if (!value) throw new Error('Sandbox helper request is required');
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('command' in parsed) ||
    typeof parsed.command !== 'string' ||
    !('workingDirectory' in parsed) ||
    typeof parsed.workingDirectory !== 'string' ||
    !('writable' in parsed) ||
    typeof parsed.writable !== 'boolean' ||
    !('network' in parsed) ||
    typeof parsed.network !== 'boolean' ||
    !('environment' in parsed) ||
    parsed.environment === null ||
    typeof parsed.environment !== 'object'
  ) {
    throw new Error('Sandbox helper request is invalid');
  }
  const environment = Object.fromEntries(
    Object.entries(parsed.environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return {
    command: parsed.command,
    workingDirectory: parsed.workingDirectory,
    writable: parsed.writable,
    network: parsed.network,
    environment,
  };
}

async function check(): Promise<void> {
  const dependencies = await SandboxManager.checkDependenciesAsync();
  const failures = [...dependencies.errors, ...dependencies.warnings];
  let available = dependencies.errors.length === 0;
  let reason = failures.length > 0 ? failures.join('; ') : undefined;
  if (available) {
    try {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      await SandboxManager.initialize(
        sandboxRuntimeConfig({
          command: 'true',
          workingDirectory: process.cwd(),
          writable: false,
          network: false,
          environment,
        }),
      );
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        'true',
        undefined,
        undefined,
        undefined,
        process.cwd(),
      );
      const child = Bun.spawn(wrapped.argv, {
        cwd: process.cwd(),
        env: wrapped.env,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        available = false;
        reason = `sandbox probe exited ${exitCode}`;
      }
    } catch (error) {
      available = false;
      reason = messageFor(error);
    }
  }
  process.stdout.write(
    JSON.stringify({
      available,
      ...(reason ? { reason } : {}),
    }),
  );
}

async function execute(encoded: string | undefined): Promise<void> {
  const request = decodeRequest(encoded);
  process.env = { ...request.environment };
  await SandboxManager.initialize(sandboxRuntimeConfig(request));
  try {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      request.command,
      undefined,
      undefined,
      undefined,
      request.workingDirectory,
    );
    const child = Bun.spawn(wrapped.argv, {
      cwd: request.workingDirectory,
      env: wrapped.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
    const exitCode = await child.exited;
    SandboxManager.cleanupAfterCommand();
    process.exitCode = exitCode;
  } finally {
    await SandboxManager.reset();
  }
}

async function setup(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Sandbox setup is only required on Windows');
  const result = await installWindowsSandboxAsync();
  if (result.cancelled) throw new Error('Windows sandbox setup was cancelled');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'check') await check();
  else if (command === 'execute') await execute(process.argv[3]);
  else if (command === 'setup') await setup();
  else throw new Error(`Unknown sandbox helper command: ${command ?? ''}`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${messageFor(error)}\n`);
    process.exitCode = 1;
  });
}
