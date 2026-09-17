import type { Provider } from '../oauth/providers'
import type { AccountClient } from './types'
import { googleClient } from './google'
import { microsoftClient } from './microsoft'
import { connectionsFor } from '../db/queries'

export function clientFor(memberId: number, provider: Provider): AccountClient {
  return provider === 'google' ? googleClient(memberId) : microsoftClient(memberId)
}

/** Every account a member has linked, in a stable order. */
export async function clientsFor(memberId: number): Promise<AccountClient[]> {
  const conns = await connectionsFor(memberId)
  return conns
    .map((c) => c.provider as Provider)
    .filter((p) => p === 'google' || p === 'microsoft')
    .sort()
    .map((p) => clientFor(memberId, p))
}

export * from './types'
