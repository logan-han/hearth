import { tool } from 'ai'
import { z } from 'zod'
import * as owm from '../providers/weather'
import { units } from '../env'
import type { ToolContext } from './context'

export function weatherTools(_ctx: ToolContext) {
  return {
    weather: tool({
      description:
        'Current conditions and the next few days, from OpenWeatherMap. Use this for any weather question ' +
        `and for morning briefs. The default location is the household's own (${owm.homeCity()}).`,
      inputSchema: z.object({
        location: z.string().optional().describe('A city or suburb. Omit for home.'),
      }),
      execute: async ({ location }) => {
        if (!owm.weatherConfigured()) return { error: 'Weather is not configured (OPENWEATHER_API_KEY missing).' }
        try {
          const place = location?.trim() || owm.homeCity()
          const at = await owm.geocode(place)
          if (!at) return { error: `OpenWeatherMap knows nowhere called "${place}".` }
          const [now, days] = await Promise.all([owm.currentWeather(at), owm.forecast(at)])
          return {
            place: `${at.name}${at.state ? `, ${at.state}` : ''}${at.country ? `, ${at.country}` : ''}`,
            units: units(),
            now,
            days,
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),
  }
}
