import { startAuth } from '@/lib/oauth/flow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return startAuth(req, 'google')
}
