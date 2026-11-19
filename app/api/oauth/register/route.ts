import { NextResponse } from 'next/server'
import { registerClient, CORS_HEADERS } from '@/lib/oauth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** RFC 7591 dynamic client registration, for an MCP client connecting for the first time. */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata', error_description: 'The registration must be JSON.' }, { status: 400, headers: CORS_HEADERS })
  }
  const { status, json } = await registerClient(body)
  return NextResponse.json(json, { status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
