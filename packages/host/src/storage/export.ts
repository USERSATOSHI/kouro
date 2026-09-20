import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Journal } from "./journal.ts";

export type BackupManifest = {
  format: 1;
  createdAt: string;
  database: { path: "kouro.sqlite"; bytes: number; sha256: string };
  blobs: Array<{ digest: string; bytes: number; sha256: string }>;
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function blobFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return blobFiles(path);
    if (entry.isFile()) return [path];
    throw new Error(`Backup refuses non-file blob entry: ${path}`);
  });
}

/** Verify backup bytes and the SQLite-to-blob closure without mutating either. */
export function verifyBackup(directory: string): BackupManifest {
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== 1 || manifest.database.path !== "kouro.sqlite")
    throw new Error("Unsupported or malformed Kouro backup manifest");
  const digests = new Set<string>();
  const database = join(directory, manifest.database.path);
  if (
    !existsSync(database) ||
    statSync(database).size !== manifest.database.bytes ||
    sha256(database) !== manifest.database.sha256
  )
    throw new Error("Backup SQLite checksum mismatch");
  const snapshot = new Database(database, { readonly: true });
  let referenced: string[];
  try {
    const check = snapshot.query("PRAGMA quick_check").get() as Record<string, string> | null;
    if (!check || Object.values(check)[0] !== "ok")
      throw new Error("Backup SQLite integrity check failed");
    referenced = (
      snapshot.query("SELECT DISTINCT digest FROM artifacts ORDER BY digest").all() as Array<{
        digest: string;
      }>
    ).map((row) => row.digest);
  } finally {
    snapshot.close();
  }
  if (
    JSON.stringify(referenced) !== JSON.stringify(manifest.blobs.map((blob) => blob.digest).sort())
  )
    throw new Error("Backup manifest does not match SQLite artifact closure");
  for (const blob of manifest.blobs) {
    if (!/^[a-f0-9]{64}$/.test(blob.digest))
      throw new Error("Backup contains an invalid blob digest");
    if (digests.has(blob.digest))
      throw new Error(`Backup contains a duplicate blob digest: ${blob.digest}`);
    digests.add(blob.digest);
    const path = join(directory, "blobs", blob.digest.slice(0, 2), blob.digest);
    if (
      !existsSync(path) ||
      statSync(path).size !== blob.bytes ||
      sha256(path) !== blob.sha256 ||
      sha256(path) !== blob.digest
    )
      throw new Error(`Backup blob checksum mismatch: ${blob.digest}`);
  }
  const expected = new Set(
    manifest.blobs.map((blob) => `${blob.digest.slice(0, 2)}/${blob.digest}`),
  );
  for (const path of blobFiles(join(directory, "blobs"))) {
    const actual = relative(join(directory, "blobs"), path).replaceAll("\\", "/");
    if (!expected.has(actual)) throw new Error(`Backup contains an unmanifested blob: ${actual}`);
  }
  return manifest;
}

/** Export SQLite using VACUUM INTO and only blobs referenced by that snapshot. */
export function exportBackup(
  journal: Journal,
  directory: string,
  options?: { onSnapshotReady?: () => void },
): BackupManifest {
  if (existsSync(directory)) throw new Error(`Backup destination already exists: ${directory}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, "kouro.sqlite");
  const escaped = database.replaceAll("'", "''");
  journal.db.exec(`VACUUM INTO '${escaped}'`);
  options?.onSnapshotReady?.();
  const snapshotDb = new Database(database, { readonly: true });
  const retainedDigests = (
    snapshotDb.query("SELECT DISTINCT digest FROM artifacts ORDER BY digest").all() as Array<{
      digest: string;
    }>
  ).map((row) => row.digest);
  snapshotDb.close();
  const destinationBlobs = join(directory, "blobs");
  mkdirSync(destinationBlobs, { recursive: true, mode: 0o700 });
  const blobs: BackupManifest["blobs"] = [];
  for (const blobDigest of retainedDigests) {
    if (!/^[a-f0-9]{64}$/.test(blobDigest))
      throw new Error(`Unexpected artifact digest: ${blobDigest}`);
    const relativeDigest = `${blobDigest.slice(0, 2)}/${blobDigest}`;
    const source = join(journal.dataDir, "blobs", relativeDigest);
    if (!existsSync(source)) throw new Error(`Referenced blob is missing: ${blobDigest}`);
    const target = join(destinationBlobs, relativeDigest);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    cpSync(source, target, { errorOnExist: true });
    blobs.push({ digest: blobDigest, bytes: statSync(source).size, sha256: sha256(source) });
  }
  const manifest: BackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    database: { path: "kouro.sqlite", bytes: statSync(database).size, sha256: sha256(database) },
    blobs: blobs.sort((a, b) => a.digest.localeCompare(b.digest)),
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  return manifest;
}

/** Restore only after verifying every byte; destination must be a new directory. */
export function restoreBackup(source: string, destination: string): BackupManifest {
  const manifest = verifyBackup(source);
  if (existsSync(destination))
    throw new Error(`Restore destination already exists: ${destination}`);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(join(source, "kouro.sqlite"), join(destination, "kouro.sqlite"));
  cpSync(join(source, "blobs"), join(destination, "blobs"), { recursive: true });
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  return verifyBackup(destination);
}
