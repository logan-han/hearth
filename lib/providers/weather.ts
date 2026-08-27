import { timezone, units } from '../env'

/**
 * OpenWeatherMap, free tier: geocoding, current conditions, and the 5-day
 * 3-hourly forecast folded into per-day digests. Temperatures follow the
 * household's UNITS setting.
 */

export function weatherConfigured(): boolean {
  return Boolean(process.env.OPENWEATHER_API_KEY)
}

/** The household's city, read off the timezone: Australia/Melbourne → Melbourne. */
export function homeCity(): string {
  return (timezone().split('/').pop() ?? 'Melbourne').replace(/_/g, ' ')
}

export type Geo = { name: string; lat: number; lon: number; country?: string; state?: string }

// Weather barely moves inside these windows, and the free tier should never be
// dented by a chatty household or an hourly watcher. Per warm lambda, keyed by
// everything except the api key; only successes are kept.
const TTL_MS = { geocode: 24 * 3600_000, current: 10 * 60_000, forecast: 30 * 60_000 } as const
const cache = new Map<string, { at: number; value: unknown }>()

export function clearWeatherCache(): void {
  cache.clear()
}

async function owm<T>(kind: keyof typeof TTL_MS, path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) throw new Error('Weather is not configured (OPENWEATHER_API_KEY missing).')
  const url = new URL(path, 'https://api.openweathermap.org')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const cacheKey = url.toString()
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL_MS[kind]) return hit.value as T

  url.searchParams.set('appid', key)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OpenWeatherMap said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const value = (await res.json()) as T
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}

export async function geocode(place: string): Promise<Geo | null> {
  const found = await owm<Geo[]>('geocode', '/geo/1.0/direct', { q: place.toLowerCase(), limit: '1' })
  return found[0] ?? null
}

type CurrentResponse = {
  weather?: { description?: string }[]
  main?: { temp?: number; feels_like?: number; humidity?: number }
  wind?: { speed?: number }
  rain?: { '1h'?: number }
}

export async function currentWeather(at: Geo) {
  const r = await owm<CurrentResponse>('current', '/data/2.5/weather', {
    lat: String(at.lat), lon: String(at.lon), units: units(),
  })
  return {
    description: r.weather?.[0]?.description ?? 'unknown',
    temp: r.main?.temp ?? null,
    feels_like: r.main?.feels_like ?? null,
    humidity: r.main?.humidity ?? null,
    wind_speed: r.wind?.speed ?? null,
    rain_last_hour_mm: r.rain?.['1h'] ?? 0,
  }
}

type ForecastResponse = {
  city?: { timezone?: number }
  list?: { dt: number; main?: { temp_min?: number; temp_max?: number }; weather?: { main?: string }[]; rain?: { '3h'?: number } }[]
}

/** The 3-hourly feed folded into one line per local day, four days out. */
export async function forecast(at: Geo) {
  const r = await owm<ForecastResponse>('forecast', '/data/2.5/forecast', {
    lat: String(at.lat), lon: String(at.lon), units: units(),
  })
  const offset = r.city?.timezone ?? 0

  const byDay = new Map<string, { min: number; max: number; rain: number; conditions: string[] }>()
  for (const slot of r.list ?? []) {
    const day = new Date((slot.dt + offset) * 1000).toISOString().slice(0, 10)
    const entry = byDay.get(day) ?? { min: Infinity, max: -Infinity, rain: 0, conditions: [] }
    entry.min = Math.min(entry.min, slot.main?.temp_min ?? Infinity)
    entry.max = Math.max(entry.max, slot.main?.temp_max ?? -Infinity)
    entry.rain += slot.rain?.['3h'] ?? 0
    if (slot.weather?.[0]?.main) entry.conditions.push(slot.weather[0].main)
    byDay.set(day, entry)
  }

  const commonest = (list: string[]) => {
    const tally = new Map<string, number>()
    for (const c of list) tally.set(c, (tally.get(c) ?? 0) + 1)
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
  }

  return [...byDay.entries()].slice(0, 4).map(([day, d]) => ({
    day,
    min: Number.isFinite(d.min) ? Math.round(d.min) : null,
    max: Number.isFinite(d.max) ? Math.round(d.max) : null,
    condition: commonest(d.conditions),
    rain_mm: Math.round(d.rain * 10) / 10,
  }))
}
