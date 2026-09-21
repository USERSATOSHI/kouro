import { describe, expect, test } from "bun:test";
import { nativeLockLibrary } from "../src/storage/lock.ts";
import { createDefaultProcessAdapter } from "../src/adapters/process/index.ts";
import { DarwinSandboxProcessAdapter } from "../src/adapters/process/darwin.ts";
import { BubblewrapProcessAdapter } from "../src/adapters/process/bwrap.ts";

describe("native owner lock library", () => {
  test("selects the system library for supported Unix platforms", () => {
    expect(nativeLockLibrary("linux")).toBe("libc.so.6");
    expect(nativeLockLibrary("darwin")).toBe("/usr/lib/libSystem.B.dylib");
    expect(nativeLockLibrary("freebsd")).toBe("libc.so.7");
  });

  test("fails clearly for unsupported platforms", () => {
    expect(() => nativeLockLibrary("win32")).toThrow("owner locking is not supported on win32");
  });
});

describe("default process adapter", () => {
  test("selects native enforced adapters by platform", () => {
    expect(createDefaultProcessAdapter("linux")).toBeInstanceOf(BubblewrapProcessAdapter);
    expect(createDefaultProcessAdapter("darwin")).toBeInstanceOf(DarwinSandboxProcessAdapter);
    expect(() => createDefaultProcessAdapter("win32")).toThrow(/not supported on win32/);
  });
});
