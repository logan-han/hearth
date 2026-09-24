/**
 * How long one request to an outside service may take. A service that takes
 * the connection and then never answers would otherwise hold the request until
 * the platform stops the whole function at 300 seconds: the turn gets no reply
 * and no second model, and a tick loses the automation it was running. The
 * model call's own step timeout cannot cut a tool short, since the step waits
 * for the tool whatever happens.
 */
export function deadline(ms = 20_000): AbortSignal {
  return AbortSignal.timeout(ms)
}

/**
 * A write whose request ran out of time. The service may have acted on it
 * before its answer was lost, so it is neither done nor safe to do again:
 * someone has to look.
 */
export class UnconfirmedError extends Error {
  constructor(options?: ErrorOptions) {
    super('It took too long to be confirmed, so it may or may not have gone through.', options)
    this.name = 'UnconfirmedError'
  }
}

/**
 * Make the one request that is a write, and turn its running out of time
 * into an UnconfirmedError. A timeout before it, on a token refresh or a
 * read, stays a plain one: nothing had been asked of the service yet.
 */
export async function unconfirmedOnTimeout<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    throw e instanceof Error && e.name === 'TimeoutError' ? new UnconfirmedError({ cause: e }) : e
  }
}
