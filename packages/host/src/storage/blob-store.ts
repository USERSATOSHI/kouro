import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRef } from "../types.ts";
import { id, now } from "../id.ts";

export interface StoredBlobRef extends ArtifactRef {
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly runId: string;
  readonly createdAt: string;
}

export class BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "blobs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });
  }

  put(runId: string, bytes: Uint8Array, mediaType = "application/octet-stream"): StoredBlobRef {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const destination = join(this.root, "blobs", digest.slice(0, 2), digest);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (!existsSync(destination)) {
      const temporary = join(this.root, "tmp", `${id("blob")}.partial`);
      writeFileSync(temporary, bytes, { mode: 0o600 });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, destination);
      const directoryFd = openSync(dirname(destination), "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    return {
      id: `artifact_${randomUUID().replaceAll("-", "")}`,
      digest,
      mediaType,
      byteLength: bytes.byteLength,
      runId,
      createdAt: now(),
    };
  }

  pathForDigest(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest");
    return join(this.root, "blobs", digest.slice(0, 2), digest);
  }

  read(ref: Pick<ArtifactRef, "digest">): Uint8Array {
    if (!ref.digest) throw new Error("Artifact has no content digest");
    const path = this.pathForDigest(ref.digest);
    const bytes = new Uint8Array(readFileSync(path));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== ref.digest) throw new Error("Artifact checksum mismatch");
    return bytes;
  }
}

export async function readBlob(
  ref: Pick<ArtifactRef, "digest">,
  root: string,
): Promise<Uint8Array> {
  const digest = ref.digest;
  if (!digest) throw new Error("Artifact has no content digest");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest");
  return new Uint8Array(
    await Bun.file(join(root, "blobs", digest.slice(0, 2), digest)).arrayBuffer(),
  );
}
