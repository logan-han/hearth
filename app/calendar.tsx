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
  days: CalendarDay[]
}

export function Calendar({ month: initial }: { month: MonthData }) {
  const [month, setMonth] = useState(initial)
  const [loading, setLoading] = useState(false)
  const cache = useRef(new Map<string, MonthData>([[initial.key, initial]]))

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
    // button walks back through the months you looked at.
    if (push) history.pushState({ month: key }, '', key === initial.key ? '/' : `/?month=${key}`)
  }, [initial.key])

  // Warm the neighbours, so the common case of stepping one month is instant.
  useEffect(() => {
    for (const key of [month.prev, month.next]) {
      if (cache.current.has(key)) continue
      fetch(`/api/month?month=${key}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && cache.current.set(d.calendar.key, d.calendar))
        .catch(() => {})
    }
  }, [month.prev, month.next])

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const key = (e.state as { month?: string } | null)?.month
        ?? new URLSearchParams(location.search).get('month')
        ?? initial.key
      load(key, { push: false })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [load, initial.key])

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

  return (
    <section>
      <div className="cal-head">
        <h2 aria-live="polite">{month.label}</h2>
        <nav className="cal-nav">
          <button onClick={() => load(month.prev)} aria-label="Previous month">←</button>
          {month.isCurrent ? null : <button onClick={() => load(initial.key)}>Today</button>}
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
          {month.days.map((d) => (
            <div
              key={d.date}
              className={`cal-day${d.inMonth ? '' : ' outside'}${d.isToday ? ' today' : ''}`}
            >
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
            </div>
          ))}
        </div>
        {empty ? (
          <p className="empty" style={{ marginTop: '0.9rem' }}>
            Nothing on the family calendar this month.
          </p>
        ) : null}
      </div>
    </section>
  )
}
