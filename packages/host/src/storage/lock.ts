import { openSync, closeSync, constants as fsConstants } from "node:fs";
import { dlopen } from "bun:ffi";

// flock(2) uses the same operation values on the supported Unix platforms.
// Keeping these explicit avoids accidentally implementing a stale PID lock.
const LOCK_EX = 2;
const LOCK_NB = 4;

export function nativeLockLibrary(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "/usr/lib/libSystem.B.dylib";
    case "freebsd":
      return "libc.so.7";
    case "linux":
      return "libc.so.6";
    default:
      throw new Error(
        `Kouro owner locking is not supported on ${platform}; supported platforms are Linux, macOS, and FreeBSD`,
      );
  }
}

/**
 * A lifetime lock backed by the kernel's advisory flock. A marker file is not
 * enough: marker/PID locks become stale after an unclean process exit.
 */
export class OwnerLock {
  private fd: number | null = null;
  private readonly flock: (fd: number, operation: number) => number;

  constructor(private readonly path: string) {
    const libc = dlopen(nativeLockLibrary(), {
      flock: { args: ["int", "int"], returns: "int" },
    });
    this.flock = libc.symbols.flock as (fd: number, operation: number) => number;
  }

  acquire(): void {
    if (this.fd !== null) return;
    const fd = openSync(this.path, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
    if (this.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      closeSync(fd);
      throw new Error(`Kouro data directory is already owned: ${this.path}`);
    }
    this.fd = fd;
  }

  release(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  get held(): boolean {
    return this.fd !== null;
  }
}
