/** Only provider limits are resumable waits. Ordinary errors remain failures. */
export function providerLimit(error: string | undefined): "usage-limit" | "turn-limit" | undefined {
  if (!error) return undefined;
  if (/error_max_turns|maximum.*turns|max[ _-]?turns/i.test(error)) return "turn-limit";
  if (
    /usage[ _-]?limit|rate[ _-]?limit|quota|hit your limit|hit.*usage.*limit|limit.*resets|too many requests|\b429\b/i.test(
      error,
    )
  )
    return "usage-limit";
  return undefined;
}
