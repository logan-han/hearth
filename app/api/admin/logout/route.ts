import { NextResponse } from 'next/server'
import { destroySession } from '@/lib/auth/session'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  await destroySession()
  return NextResponse.redirect(appUrl(), { status: 303 })
}
