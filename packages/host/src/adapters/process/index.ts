import type { ProcessAdapter } from "../../types.ts";
import { DarwinSandboxProcessAdapter } from "./darwin.ts";
import { BubblewrapProcessAdapter } from "./bwrap.ts";

export { DarwinSandboxProcessAdapter } from "./darwin.ts";
export { BubblewrapProcessAdapter, FakeProcessAdapter } from "./bwrap.ts";

export function createDefaultProcessAdapter(
  platform: NodeJS.Platform = process.platform,
): ProcessAdapter {
  if (platform === "darwin") return new DarwinSandboxProcessAdapter();
  if (platform === "linux") return new BubblewrapProcessAdapter();
  throw new Error(
    `Enforced process execution is not supported on ${platform}; supported platforms are Linux and macOS`,
  );
}
