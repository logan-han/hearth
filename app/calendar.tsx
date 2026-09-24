'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarDay } from '@/lib/stats'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SHOWN_PER_DAY = 3

export type MonthData = {
  key: string
  label: string
  prev: string
  next: string
  isCurrent: boolean
  /** The month today is in: where Today goes, and what the bare address shows. */
  thisMonth: string
  days: CalendarDay[]
}

/** "Wednesday 9 September", from the date key alone, so the reader's own zone cannot move it a day. */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  )
}

export function Calendar({ month: initial }: { month: MonthData }) {
  const [month, setMonth] = useState(initial)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const cache = useRef(new Map<string, MonthData>([[initial.key, initial]]))

  // A change made elsewhere on Home refreshes the page, which hands this a
  // fresh copy of the month on screen; state seeded from the first copy would
  // keep showing a cancelled event. The months cached before the change go
  // too, since the change may be in any of them.
  useEffect(() => {
    cache.current = new Map([[initial.key, initial]])
    setMonth(initial)
  }, [initial])

  const load = useCallback(async (key: string, { push = true } = {}) => {
    const cached = cache.current.get(key)
    if (cached) {
      setMonth(cached)
    } else {
      setLoading(true)
      try {
        const res = await fetch(`/api/month?month=${key}`)
        if (!res.ok) return
        const { calendar } = (await res.json()) as { calendar: MonthData }
        cache.current.set(calendar.key, calendar)
        setMonth(calendar)
      } finally {
        setLoading(false)
      }
    }
    // Keep the address bar honest, so a month stays linkable and the back
    // button walks back through the months you looked at. The bare address
    // is this month, not whichever month the page happened to load on.
    if (push) history.pushState({ month: key }, '', key === initial.thisMonth ? '/' : `/?month=${key}`)
  }, [initial.thisMonth])

  // Warm the neighbours, so the common case of stepping one month is instant.
  // Keyed on the month itself, so a fresh copy after a change warms them again,
  // and each lands in the cache it was asked for, not one a change has replaced.
  useEffect(() => {
    const into = cache.current
    for (const key of [month.prev, month.next]) {
      if (into.has(key)) continue
      fetch(`/api/month?month=${key}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && into.set(d.calendar.key, d.calendar))
        .catch(() => {})
    }
  }, [month])

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const key = (e.state as { month?: string } | null)?.month
        ?? new URLSearchParams(location.search).get('month')
        ?? initial.thisMonth
      load(key, { push: false })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [load, initial.thisMonth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') load(month.prev)
      if (e.key === 'ArrowRight') load(month.next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [load, month.prev, month.next])

  const empty = month.days.every((d) => d.events.length === 0)
  const pickedDay = month.days.find((d) => d.date === picked && d.events.length > 0)

  return (
    <section>
      <div className="cal-head">
        <h2 aria-live="polite">{month.label}</h2>
        <nav className="cal-nav">
          <button onClick={() => load(month.prev)} aria-label="Previous month">←</button>
          {month.isCurrent ? null : <button onClick={() => load(month.thisMonth)}>Today</button>}
          <button onClick={() => load(month.next)} aria-label="Next month">→</button>
        </nav>
      </div>

      <div className={`panel cal-panel${loading ? ' loading' : ''}`}>
        <div className="cal">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-weekday" aria-hidden>
              {w}
            </div>
          ))}
          {month.days.map((d) => {
            const className = `cal-day${d.inMonth ? '' : ' outside'}${d.isToday ? ' today' : ''}${d === pickedDay ? ' chosen' : ''}`
            const cell = (
              <>
                <span className="cal-date">{d.day}</span>
                {d.events.slice(0, SHOWN_PER_DAY).map((e, i) => (
                  <span className="cal-event" key={`${e.title}-${i}`} title={e.title}>
                    {e.time ? <b>{e.time}</b> : null}
                    {e.title}
                  </span>
                ))}
                {d.events.length > SHOWN_PER_DAY ? (
                  <span className="cal-more">+{d.events.length - SHOWN_PER_DAY} more</span>
                ) : null}
              </>
            )
            // A cell has room for the start of a title, and on a phone barely
            // that, with no tooltip to touch; a day with anything on it opens
            // in full beneath the grid instead, the ones past the third included.
            return d.events.length === 0 ? (
              <div key={d.date} className={className}>
                {cell}
              </div>
            ) : (
              <button
                key={d.date}
                type="button"
                className={className}
                aria-pressed={d === pickedDay}
                onClick={() => setPicked(d === pickedDay ? null : d.date)}
              >
                {cell}
              </button>
            )
          })}
        </div>
        {pickedDay ? (
          <div className="cal-detail">
            <p className="subhead">{dayLabel(pickedDay.date)}</p>
            <ul className="listing">
              {pickedDay.events.map((e, i) => (
                <li key={`${e.title}-${i}`}>
                  <span className="title">{e.title}</span>
                  <span className="meta">{e.time ?? 'all day'}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {empty ? (
          <p className="empty" style={{ marginTop: '0.9rem' }}>
            Nothing on the family calendar this month.
          </p>
        ) : null}
      </div>
    </section>
  )
}
