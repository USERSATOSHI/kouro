import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { compileEvaluationDataset, type CompiledEvaluationDataset } from '@kouro/evaluations';
import { err, ok, type Result } from '@usersatoshi/results';

import {
  EvaluationDatasetSourceErrorKind,
  type EvaluationDatasetSource,
  type EvaluationDatasetSourceError,
} from './ports.ts';

function sourceError(
  kind: EvaluationDatasetSourceErrorKind,
  message: string,
): EvaluationDatasetSourceError {
  return { kind, message };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Loads regular JSON datasets directly under a repository's evaluation directory. */
export class LocalEvaluationDatasetSource implements EvaluationDatasetSource {
  async list(
    repositoryPath: string,
  ): Promise<Result<readonly CompiledEvaluationDataset[], EvaluationDatasetSourceError>> {
    const directory = resolve(repositoryPath, '.kouro', 'evaluations');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
      return code === 'ENOENT'
        ? ok([])
        : err(
            sourceError(
              EvaluationDatasetSourceErrorKind.ReadFailure,
              `Evaluation directory could not be read: ${directory}`,
            ),
          );
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(({ name }) => name)
      .toSorted();
    const datasets: CompiledEvaluationDataset[] = [];
    for (const file of files) {
      const loaded = await this.read(join(directory, file));
      if (loaded.isErr()) return loaded;
      datasets.push(loaded.value);
    }
    const ids = datasets.map(({ dataset }) => dataset.id);
    if (new Set(ids).size !== ids.length) {
      return err(
        sourceError(
          EvaluationDatasetSourceErrorKind.InvalidDataset,
          'Repository evaluation dataset IDs must be unique',
        ),
      );
    }
    return ok(datasets.toSorted((left, right) => compareText(left.dataset.id, right.dataset.id)));
  }

  async load(
    repositoryPath: string,
    datasetId: string,
  ): Promise<Result<CompiledEvaluationDataset, EvaluationDatasetSourceError>> {
    const listed = await this.list(repositoryPath);
    if (listed.isErr()) return listed;
    const dataset = listed.value.find(({ dataset: definition }) => definition.id === datasetId);
    return dataset
      ? ok(dataset)
      : err(
          sourceError(
            EvaluationDatasetSourceErrorKind.NotFound,
            `Evaluation dataset ${datasetId} was not found`,
          ),
        );
  }

  private async read(
    path: string,
  ): Promise<Result<CompiledEvaluationDataset, EvaluationDatasetSourceError>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return err(
        sourceError(
          EvaluationDatasetSourceErrorKind.ReadFailure,
          `Evaluation dataset could not be parsed: ${path}`,
        ),
      );
    }
    const compiled = compileEvaluationDataset(parsed);
    return compiled.isOk()
      ? compiled
      : err(
          sourceError(
            EvaluationDatasetSourceErrorKind.InvalidDataset,
            `${path}: ${compiled.error.message}`,
          ),
        );
  }
}
