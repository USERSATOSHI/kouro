import { describe, expect, test } from "bun:test";
import { nativeLockLibrary } from "../src/storage/lock.ts";

describe("native owner lock library", () => {
  test("selects the system library for supported Unix platforms", () => {
    expect(nativeLockLibrary("linux")).toBe("libc.so.6");
    expect(nativeLockLibrary("darwin")).toBe("/usr/lib/libSystem.B.dylib");
    expect(nativeLockLibrary("freebsd")).toBe("libc.so.7");
  });

  test("fails clearly for unsupported platforms", () => {
    expect(() => nativeLockLibrary("win32")).toThrow(
      "owner locking is not supported on win32",
    );
  });
});
