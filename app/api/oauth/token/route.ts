import { NextResponse } from 'next/server'
import { exchangeToken, CORS_HEADERS } from '@/lib/oauth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The token endpoint: a code and its PKCE verifier, traded for an MCP key in the approving member's name. */
export async function POST(req: Request) {
  let form: URLSearchParams
  try {
    const type = req.headers.get('content-type') ?? ''
    // OAuth sends a form; a client that sends JSON instead is met halfway.
    form = type.includes('application/json')
      ? new URLSearchParams(Object.entries((await req.json()) as Record<string, string>).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(await req.text())
  } catch {
    return NextResponse.json({ error: 'invalid_request', error_description: 'The request could not be read.' }, { status: 400, headers: CORS_HEADERS })
  }
  const { status, json } = await exchangeToken(form)
  return NextResponse.json(json, { status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', Pragma: 'no-cache' } })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
