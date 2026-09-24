import { NextResponse } from 'next/server'
import { destroySession, requireAdmin } from '@/lib/auth/session'
import { signOutEverywhere } from '@/lib/auth/keys'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // Everywhere is for a session left open somewhere it should not be: it ends
  // every session and voids every /connect link still out, and only an admin
  // may ask. Anyone else asking is signed out alone.
  const form = await req.formData().catch(() => null)
  if (form?.get('everywhere') && (await requireAdmin())) await signOutEverywhere()
  await destroySession()
  return NextResponse.redirect(appUrl(), { status: 303 })
}
