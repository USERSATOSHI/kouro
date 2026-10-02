import { expect, test } from "bun:test";
import { readApiJson } from "./apiResponse";

test("identifies an HTML response from a stale host without exposing its body or token", async () => {
  const response = new Response("<html>private response body</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const error = await readApiJson<never>(response, "/api/task-workflows?token=private-token").catch(
    (cause: unknown) => cause as Error,
  );
  expect(error.message).toContain("/api/task-workflows returned text/html instead of JSON");
  expect(error.message).toContain("bun run dev");
  expect(error.message).not.toContain("private");
});

test("reports malformed JSON at the session endpoint", async () => {
  await expect(
    readApiJson(
      new Response("not json", { headers: { "content-type": "application/json" } }),
      "/api/session",
    ),
  ).rejects.toThrow("/api/session returned invalid JSON");
});

test("accepts JSON and structured JSON content types", async () => {
  for (const contentType of ["application/json;charset=utf-8", "application/problem+json"]) {
    expect(
      await readApiJson<{ value: number }>(
        new Response('{"value":42}', { headers: { "content-type": contentType } }),
        "/api/test",
      ),
    ).toEqual({ value: 42 });
  }
});
