import { treaty } from '@elysiajs/eden';
import { BunCommandRunner, RunCoordinator } from '@kouro/executors';
import { SqliteEvaluationStore, SqliteEventStore } from '@kouro/persistence-sqlite';
import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  SqliteTicketSyncStore,
} from '@kouro/tickets';
import { err, ok, type Result } from '@usersatoshi/results';

import { createKouroApp, type KouroApp } from './app.ts';
import { LocalArtifactContentReader } from './local-artifact-content-reader.ts';
import { LocalEvaluationDatasetSource } from './local-evaluation-dataset-source.ts';
import { KouroTicketRunQuery } from './ticket-run-query.ts';

export interface ComposedKouroApp {
  readonly app: KouroApp;
  dispose(): void;
}

export interface CompositionError {
  readonly kind: 0;
  readonly message: string;
}

/** Composes the single-process MVP with SQLite and a local command runner. */
export function composeKouroApp(
  databasePath: string,
  artifactRoot?: string,
): Result<ComposedKouroApp, CompositionError> {
  const store = new SqliteEventStore(databasePath);
  const initialized = store.initialize();
  if (initialized.isErr()) {
    store.dispose();
    return err({ kind: 0, message: 'The SQLite run store could not be initialized' });
  }
  const coordinator = new RunCoordinator(store, new BunCommandRunner(process.cwd()));
  const evaluations = new SqliteEvaluationStore(databasePath);
  const evaluationsInitialized = evaluations.initialize();
  if (evaluationsInitialized.isErr()) {
    evaluations.dispose();
    store.dispose();
    return err({ kind: 0, message: 'The SQLite evaluation store could not be initialized' });
  }
  const tickets = new SqliteTicketRepository(databasePath);
  const ticketRuns = new SqliteTicketRunStore(databasePath);
  const ticketSync = new SqliteTicketSyncStore(databasePath);
  for (const initializedTickets of [
    tickets.initialize(),
    ticketRuns.initialize(),
    ticketSync.initialize(),
  ]) {
    if (initializedTickets.isErr()) {
      ticketSync.dispose();
      ticketRuns.dispose();
      tickets.dispose();
      evaluations.dispose();
      store.dispose();
      return err({ kind: 0, message: 'The SQLite ticket stores could not be initialized' });
    }
  }
  return ok({
    app: createKouroApp({
      runs: store,
      coordinator,
      ...(artifactRoot ? { artifacts: new LocalArtifactContentReader(artifactRoot) } : {}),
      tickets: {
        repository: tickets,
        runs: ticketRuns,
        runQuery: new KouroTicketRunQuery(store),
        sync: ticketSync,
      },
      evaluations: {
        datasets: new LocalEvaluationDatasetSource(),
        store: evaluations,
        clock: { now: () => new Date().toISOString() },
      },
    }),
    dispose(): void {
      ticketSync.dispose();
      ticketRuns.dispose();
      tickets.dispose();
      evaluations.dispose();
      store.dispose();
    },
  });
}

/** Creates the typed Eden client consumed by the dashboard. */
export function createKouroClient(baseUrl: string) {
  return treaty<KouroApp>(baseUrl);
}
