import { addAutomation, deleteAutomation, groupChats, listAutomations, syncAutomation } from './db/queries'
import { nextRun } from './cron'
import { BUILTIN_WATCHERS, WATCHERS, watcherInstruction } from './watchers'
import { unaccountedIn } from './headcount'
import type { Automation } from './db/schema'

export type BuiltinReport = { installed: string[]; converted: number; retired: number; synced: number }

/**
 * Every household group gets the built-in watchers without anyone asking, and
 * keeps them in step with their definitions: a label, schedule or phrasing
 * changed in code reaches the rows on the next tick. Idempotent and cheap, so
 * the tick runs it every time. A paused one stays paused: the household said
 * no, and only the household says yes again. A room with someone unrecognised
 * in it is not the household's room, and is left alone until they go. That
 * includes someone who has never spoken: before anything is installed,
 * Telegram's head count has to match the bot plus the allowed members it says
 * are there, or a group the bot was added to for one question would start
 * getting everyone's mail every morning.
 *
 * The retired inbox watcher's job moved into the morning brief. A chat's
 * inbox row becomes its brief, owner and all, unless the chat already has one,
 * in which case it simply goes. The mail cursor is keyed by chat, so the brief
 * carries on from where the sweep left off rather than replaying the inbox.
 */
export async function installBuiltins(
  now: Date = new Date(),
  on: { counted?: (room: { chatId: string; title: string | null }, unaccounted: number | null) => Promise<void> } = {},
): Promise<BuiltinReport> {
  const report: BuiltinReport = { installed: [], converted: 0, retired: 0, synced: 0 }
  const [rooms, all] = await Promise.all([groupChats(), listAutomations()])

  for (const legacy of all.filter((a) => a.kind === 'inbox')) {
    if (all.some((b) => b.chatId === legacy.chatId && b.kind === 'morning')) {
      await deleteAutomation(legacy.id)
      report.retired++
      continue
    }
    const brief = WATCHERS.morning
    const next = nextRun(brief.cron, now)
    const patch = {
      kind: brief.kind,
      label: brief.label,
      cronExpr: brief.cron,
      instruction: watcherInstruction(brief.kind, legacy.chatId),
      ...(legacy.enabled && next ? { nextRunAt: next } : {}),
    }
    await syncAutomation(legacy.id, patch)
    Object.assign(legacy, patch)
    report.converted++
  }
  // What is left after the legacy pass: converted rows now read as briefs, deleted ones still say inbox.
  const live = all.filter((a) => a.kind !== 'inbox')

  for (const room of rooms) {
    if (room.strangers.length > 0) continue
    // Asked at most once per room, and only when something would be installed.
    let accounted: boolean | undefined
    for (const watcher of BUILTIN_WATCHERS) {
      const instruction = watcherInstruction(watcher.kind, room.chatId)
      const have = live.find((a) => a.chatId === room.chatId && a.kind === watcher.kind)
      if (!have) {
        const next = nextRun(watcher.cron, now)
        if (!next) continue
        if (accounted === undefined) {
          const unaccounted = await unaccountedIn(room.chatId)
          accounted = unaccounted === 0
          if (!accounted) {
            console.info(
              `[builtins] not installing in ${room.title ?? room.chatId}: ` +
                `${unaccounted ?? 'an unknown number of'} people there are not recognised`,
            )
          }
          // Said to an admin by the caller, who knows how; a room left without
          // its watchers and nobody told is a household that never gets a brief.
          await on.counted?.(room, unaccounted)
        }
        if (!accounted) continue
        await addAutomation({
          chatId: room.chatId,
          memberId: null,
          label: watcher.label,
          cronExpr: watcher.cron,
          instruction,
          kind: watcher.kind,
          nextRunAt: next,
        })
        report.installed.push(`${watcher.label} in ${room.title ?? room.chatId}`)
        continue
      }
      if (!inStep(have, watcher.label, watcher.cron, instruction)) {
        // A new schedule takes effect now; a paused row keeps its stale time,
        // which resuming recomputes anyway.
        const next = have.enabled && have.cronExpr !== watcher.cron ? nextRun(watcher.cron, now) : null
        await syncAutomation(have.id, {
          label: watcher.label,
          cronExpr: watcher.cron,
          instruction,
          ...(next ? { nextRunAt: next } : {}),
        })
        report.synced++
      }
    }
  }

  return report
}

const inStep = (a: Automation, label: string, cron: string, instruction: string) =>
  a.label === label && a.cronExpr === cron && a.instruction === instruction
