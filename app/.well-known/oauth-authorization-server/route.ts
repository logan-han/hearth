import { NextResponse } from 'next/server'
import { authorizationServerMetadata, CORS_HEADERS } from '@/lib/oauth/server'

export const dynamic = 'force-dynamic'

/** RFC 8414 metadata: where an MCP client registers, sends its member to approve it, and trades the code. */
export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { ...CORS_HEADERS, 'Cache-Control': 'max-age=3600' } })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
