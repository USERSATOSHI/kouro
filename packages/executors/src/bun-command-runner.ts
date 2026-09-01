import { fromAsync } from '@usersatoshi/results';

import {
  CommandRunnerErrorKind,
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
} from './ports.ts';

function processFailure(error: unknown): CommandRunnerError {
  return {
    kind: CommandRunnerErrorKind.ProcessFailure,
    message: error instanceof Error ? error.message : 'Command process failed',
  };
}

export class BunCommandRunner implements CommandRunner {
  constructor(private readonly workingDirectory: string) {}

  async execute(command: string, workingDirectory = this.workingDirectory) {
    return fromAsync<CommandExecution, CommandRunnerError>(async () => {
      const subprocess = Bun.spawn(['bash', '-lc', command], {
        cwd: workingDirectory,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      return {
        outcome: exitCode === 0 ? 'success' : 'failure',
        output: {
          exitCode,
          stdout,
          stderr,
        },
      };
    }, processFailure);
  }
}
