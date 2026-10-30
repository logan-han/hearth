/**
 * When people are free, worked out in code from when they are busy. A model
 * asked to find a gap in three calendars at once misses overlaps and invents
 * free afternoons; subtracting intervals does not.
 */

export type Span = { start: Date; end: Date }

const MINUTE = 60_000

/** The busy spans merged where they overlap or touch, soonest first. */
export function merge(busy: readonly Span[]): Span[] {
  const sorted = busy.filter((b) => b.end > b.start).sort((a, b) => a.start.getTime() - b.start.getTime())
  const out: Span[] = []
  for (const b of sorted) {
    const last = out.at(-1)
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = new Date(b.end)
    } else {
      out.push({ start: new Date(b.start), end: new Date(b.end) })
    }
  }
  return out
}

/**
 * The stretches of each window nobody is busy in that last at least
 * `minutes`, soonest first. A window is a day's searchable hours; anything
 * outside them is never offered, however free.
 */
export function freeSpans(windows: readonly Span[], busy: readonly Span[], minutes: number): Span[] {
  const blocked = merge(busy)
  const out: Span[] = []
  for (const w of windows) {
    let cursor = w.start
    for (const b of blocked) {
      // Only what overlaps the window from the cursor on: it starts before the window ends and ends after the cursor.
      if (b.end <= cursor || b.start >= w.end) continue
      if (b.start > cursor) out.push({ start: cursor, end: b.start })
      cursor = b.end
      if (cursor >= w.end) break
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end })
  }
  return out.filter((s) => s.end.getTime() - s.start.getTime() >= minutes * MINUTE)
}

/** The next quarter hour at or after `at`, so a slot never starts at 9:07. */
export function nextQuarter(at: Date): Date {
  const q = 15 * MINUTE
  return new Date(Math.ceil(at.getTime() / q) * q)
}
