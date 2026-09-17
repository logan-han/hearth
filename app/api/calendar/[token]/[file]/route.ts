import { GET as feed } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Calendar apps like a .ics filename on the end; both paths serve the same feed. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string; file: string }> }) {
  const { token } = await ctx.params
  return feed(req, { params: Promise.resolve({ token }) })
}
