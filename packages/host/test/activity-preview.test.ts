import { expect, test } from "bun:test";
import { activityPreview } from "../src/adapters/harness/activity-preview.ts";

test("large tool previews bound strings and field names while preserving readable structure", () => {
  const preview = activityPreview({ stdout: "x".repeat(100000), exitCode: 0 });
  expect(preview).toMatchObject({ exitCode: 0 });
  expect(JSON.stringify(preview)).toContain("preview truncated");
  expect(JSON.stringify(preview).length).toBeLessThan(33000);
  const hugeKeys = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `${index}-` + "a".repeat(100000),
      "y".repeat(100000),
    ]),
  );
  expect(JSON.stringify(activityPreview(hugeKeys)).length).toBeLessThan(35000);
});
