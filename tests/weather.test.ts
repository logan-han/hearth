import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ToolContext } from '@/lib/tools/context'

const { weatherTools } = await import('@/lib/tools/weather')
const weather = await import('@/lib/providers/weather')

const fetchMock = vi.fn()
const ctx: ToolContext = { chatId: '-1', member: null, memberName: 'Logan', now: new Date(), notices: [] }
const call = (args: unknown) =>
  (weatherTools(ctx).weather.execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) })

// Midnight UTC on 1 Sep 2026; with the +10h offset these bucket into local days.
const DAY1 = Date.UTC(2026, 8, 1, 0, 0, 0) / 1000
const DAY2 = DAY1 + 24 * 3600

function happyWeather() {
  fetchMock.mockImplementation(async (u: unknown) => {
    const url = String(u)
    if (url.includes('/geo/')) return json([{ name: 'Melbourne', lat: -37.8, lon: 144.9, country: 'AU' }])
    if (url.includes('/data/2.5/weather')) {
      return json({
        weather: [{ description: 'light rain' }],
        main: { temp: 14.2, feels_like: 12.1, humidity: 81 },
        wind: { speed: 6.1 },
        rain: { '1h': 0.4 },
      })
    }
    if (url.includes('/data/2.5/forecast')) {
      return json({
        city: { timezone: 36000 },
        list: [
          { dt: DAY1, main: { temp_min: 10, temp_max: 15 }, weather: [{ main: 'Rain' }], rain: { '3h': 1.2 } },
          { dt: DAY1 + 3 * 3600, main: { temp_min: 12, temp_max: 18 }, weather: [{ main: 'Rain' }], rain: { '3h': 0.3 } },
          { dt: DAY2, main: { temp_min: 9, temp_max: 21 }, weather: [{ main: 'Clear' }] },
        ],
      })
    }
    return json({}, false, 404)
  })
}

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  process.env.OPENWEATHER_API_KEY = 'owm-key'
  process.env.TIMEZONE = 'Australia/Melbourne'
  delete process.env.UNITS
  ;(await import('@/lib/providers/weather')).clearWeatherCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('the weather tool', () => {
  it('says so when no key is set, without calling out', async () => {
    delete process.env.OPENWEATHER_API_KEY
    const r = await call({})
    expect(String(r.error)).toContain('OPENWEATHER_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('defaults to the household city, in metric', async () => {
    happyWeather()
    const r = await call({})
    expect(String(fetchMock.mock.calls[0][0])).toContain('q=melbourne')
    expect(String(fetchMock.mock.calls[1][0])).toContain('units=metric')
    expect(r.place).toBe('Melbourne, AU')
    expect(r.units).toBe('metric')
    expect((r.now as { temp: number }).temp).toBe(14.2)
  })

  it('folds the 3-hourly feed into per-day lines', async () => {
    happyWeather()
    const r = await call({})
    const days = r.days as { day: string; min: number; max: number; condition: string; rain_mm: number }[]
    expect(days).toHaveLength(2)
    expect(days[0]).toEqual({ day: '2026-09-01', min: 10, max: 18, condition: 'Rain', rain_mm: 1.5 })
    expect(days[1]).toEqual({ day: '2026-09-02', min: 9, max: 21, condition: 'Clear', rain_mm: 0 })
  })

  it('honours the imperial setting', async () => {
    process.env.UNITS = 'imperial'
    happyWeather()
    await call({ location: 'Chicago' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('q=chicago')
    expect(String(fetchMock.mock.calls[1][0])).toContain('units=imperial')
  })

  it('answers a repeat ask from cache, sparing the free tier', async () => {
    happyWeather()
    await call({})
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const again = await call({})
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((again.now as { temp: number }).temp).toBe(14.2)
  })

  it('never caches a failure', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false, 500))
    expect(String((await call({})).error)).toContain('500')
    happyWeather()
    const r = await call({})
    expect(r.place).toBe('Melbourne, AU')
  })

  it('admits when a place is unknown', async () => {
    fetchMock.mockResolvedValue(json([]))
    const r = await call({ location: 'Atlantis' })
    expect(String(r.error)).toContain('Atlantis')
  })

  it('surfaces an upstream refusal rather than inventing a forecast', async () => {
    fetchMock.mockResolvedValue(json({ cod: 401 }, false, 401))
    const r = await call({})
    expect(String(r.error)).toContain('401')
  })

  it('copes with a sparse payload, reporting unknowns rather than inventing readings', async () => {
    fetchMock.mockImplementation(async (u: unknown) => {
      const url = String(u)
      if (url.includes('/geo/')) return json([{ name: 'Nowhere', lat: 0, lon: 0 }])
      if (url.includes('/data/2.5/weather')) return json({})
      // No city block, a slot with no readings, and a slot with a temperature but no conditions.
      if (url.includes('/data/2.5/forecast')) return json({ list: [{ dt: DAY1 }, { dt: DAY2, main: { temp_min: 8 } }] })
      return json({}, false, 404)
    })
    const r = await call({ location: 'Nowhere' })
    expect(r.place).toBe('Nowhere')
    expect(r.now).toEqual({ description: 'unknown', temp: null, feels_like: null, humidity: null, wind_speed: null, rain_last_hour_mm: 0 })
    expect(r.days).toEqual([
      { day: '2026-09-01', min: null, max: null, condition: 'unknown', rain_mm: 0 },
      { day: '2026-09-02', min: 8, max: null, condition: 'unknown', rain_mm: 0 },
    ])
  })

  it('has no days at all when the forecast list is missing', async () => {
    fetchMock.mockImplementation(async (u: unknown) => {
      const url = String(u)
      if (url.includes('/geo/')) return json([{ name: 'Melbourne', lat: -37.8, lon: 144.9, country: 'AU' }])
      return json({})
    })
    expect((await call({})).days).toEqual([])
  })
})

describe('the weather client', () => {
  it('refuses to call out without a key, even when asked directly', async () => {
    delete process.env.OPENWEATHER_API_KEY
    await expect(weather.geocode('Melbourne')).rejects.toThrow('OPENWEATHER_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the home city off the timezone, with underscores as spaces', () => {
    process.env.TIMEZONE = 'America/Los_Angeles'
    expect(weather.homeCity()).toBe('Los Angeles')
    process.env.TIMEZONE = 'UTC'
    expect(weather.homeCity()).toBe('UTC')
  })
})
