/** Report a host/frontend mismatch without exposing response bodies or pairing tokens. */
export async function readApiJson<T>(response: Response, path: string): Promise<T> {
  const endpoint = path.split(/[?#]/, 1)[0];
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!contentType || !/^application\/(?:json|[\w.-]+\+json)$/i.test(contentType)) {
    throw new Error(
      `${endpoint} returned ${contentType || "a response without a content type"} instead of JSON. Restart Kouro with bun run dev from the latest checkout, then reload its printed workbench URL.`,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${endpoint} returned invalid JSON. Restart Kouro, then reload the page.`);
  }
}
