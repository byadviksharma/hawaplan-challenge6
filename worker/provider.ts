import { boundedJSON, isInvalidBody } from './body'
import { z } from 'zod'
import {
  cities,
  reading,
  timestamp,
  type Bulletin,
  type City,
  hour,
  usable,
} from '../src/domain'

export { boundedJSON }

export class SourceError extends Error {
  constructor(public readonly kind: 'rate' | 'source') {
    super(kind)
  }
}
const seconds = z
  .number()
  .int()
  .transform((n) => n * 1000)
  .pipe(timestamp)
const unit = z.enum(['μg/m³', 'µg/m³'])
const current = z.object({
  time: seconds,
  us_aqi: reading.optional(),
  pm2_5: reading.optional(),
  pm10: reading.optional(),
})
const rawSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  current,
  current_units: z.object({
    time: z.literal('unixtime'),
    us_aqi: z.literal('USAQI').optional(),
    pm2_5: unit.optional(),
    pm10: unit.optional(),
  }),
  hourly: z
    .object({
      time: z.array(seconds).max(120),
      us_aqi: z.array(reading).max(120),
    })
    .optional(),
  hourly_units: z
    .object({ time: z.literal('unixtime'), us_aqi: z.literal('USAQI') })
    .optional(),
})
export function parseProvider(raw: unknown, city: City, now: number): Bulletin {
  const parsed = rawSchema.safeParse(raw)
  if (!parsed.success) throw new SourceError('source')
  const data = parsed.data
  if (
    Math.abs(data.latitude - cities[city].lat) > 0.5 ||
    Math.abs(data.longitude - cities[city].lon) > 0.5
  )
    throw new SourceError('source')
  const c = data.current,
    u = data.current_units,
    h = data.hourly
  if (
    (c.us_aqi != null && !u.us_aqi) ||
    (c.pm2_5 != null && !u.pm2_5) ||
    (c.pm10 != null && !u.pm10)
  )
    throw new SourceError('source')
  if (
    h &&
    (!data.hourly_units ||
      h.time.length !== h.us_aqi.length ||
      h.time.some((t, i) => i > 0 && t <= h.time[i - 1]))
  )
    throw new SourceError('source')
  const result = {
    city,
    valid: c.time,
    retrieved: now,
    aqi: c.us_aqi ?? null,
    pm25: c.pm2_5 ?? null,
    pm10: c.pm10 ?? null,
    hours: h?.time.map((time, i) => ({ time, aqi: h.us_aqi[i] })) ?? [],
  }
  if (!usable(result, now)) throw new SourceError('source')
  return result
}
export function providerURL(city: City) {
  const c = cities[city]
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
  url.search = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lon),
    current: 'us_aqi,pm2_5,pm10',
    hourly: 'us_aqi',
    domains: 'cams_global',
    timeformat: 'unixtime',
    forecast_days: '3',
    past_days: '1',
  }).toString()
  return url
}
export async function fetchBulletin(city: City) {
  const unavailable = () => { throw new SourceError('source') }
  const res = await fetch(providerURL(city), {
    signal: AbortSignal.timeout(8500),
    redirect: 'manual',
  }).catch(unavailable)
  if (!res.ok) throw new SourceError(res.status === 429 ? 'rate' : 'source')
  const raw = await boundedJSON(res, 48000).catch(error => {
    if (isInvalidBody(error)) throw new SourceError('source')
    throw error
  })
  return parseProvider(raw, city, Date.now())
}
export const refreshAfter = hour / 4
