/**
 * One place to turn whatever was thrown into a line for a log or a reply.
 * Anything can be thrown in JavaScript, so `err.message` alone is not safe,
 * and the same three-way check used to be written out at every catch.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
