import { z } from 'zod'
import { NotConnectedError, ReconnectNeededError } from '../providers/token'
import { connectPage } from './context'
import { providerConfig, type Provider } from '../oauth/providers'
import { describeError } from '../errors'

/** Which of a member's linked accounts a tool acts on. */
export const providerEnum = z.enum(['google', 'microsoft'])

/** Why nothing goes on the calendar of an account its owner linked to be read only, and how they would allow it. */
export const readOnlyRefusal = (provider: Provider) =>
  `Your ${providerConfig(provider).label} account is linked read-only, so nothing is put on its calendar through it. ` +
  `You can allow it again on Hearth's Connect page: ${connectPage()}.`

/** What a member is told when they have no calendar linked to read or write through. */
export const nothingLinked = () => `No calendar linked. Link one on Hearth's Connect page: ${connectPage()}.`

/** What a member is told when one of their linked accounts fails: not linked, its link expired, or the error itself. */
export function describeAccountError(e: unknown): string {
  if (e instanceof NotConnectedError) {
    return `No ${e.provider} account linked. Link one on Hearth's Connect page: ${connectPage()}.`
  }
  if (e instanceof ReconnectNeededError) {
    return `The ${e.provider} link has expired or been revoked. Link it again on Hearth's Connect page: ${connectPage()}.`
  }
  return describeError(e)
}
