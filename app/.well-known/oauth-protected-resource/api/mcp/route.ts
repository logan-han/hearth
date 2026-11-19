import { NextResponse } from 'next/server'
import { protectedResourceMetadata, CORS_HEADERS } from '@/lib/oauth/server'

export const dynamic = 'force-dynamic'

/**
 * RFC 9728 protected-resource metadata for /api/mcp, at the path the RFC
 * gives a resource with a path of its own; /api/mcp's own 401 points here.
 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { ...CORS_HEADERS, 'Cache-Control': 'max-age=3600' } })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
