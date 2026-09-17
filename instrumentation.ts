/**
 * Runs once when a Next.js server starts. Only the Node runtime traces; the
 * pieces live in lib/telemetry.ts and stay unloaded without Langfuse keys.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { setupTelemetry } = await import('./lib/telemetry')
  await setupTelemetry()
}
