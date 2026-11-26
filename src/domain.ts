import { z } from 'zod'

export const cities = {
  delhi: {
    name: 'Delhi',
    region: 'National Capital Territory',
    lat: 28.65195,
    lon: 77.23149,
  },
  noida: { name: 'Noida', region: 'Uttar Pradesh', lat: 28.58, lon: 77.33 },
  gurugram: {
    name: 'Gurugram',
    region: 'Haryana',
    lat: 28.4601,
    lon: 77.02635,
  },
  mumbai: {
    name: 'Mumbai',
    region: 'Maharashtra',
    lat: 19.07283,
    lon: 72.88261,
  },
  kolkata: {
    name: 'Kolkata',
    region: 'West Bengal',
    lat: 22.56263,
    lon: 88.36304,
  },
  bengaluru: {
    name: 'Bengaluru',
    region: 'Karnataka',
    lat: 12.97194,
    lon: 77.59369,
  },
} as const
export const citySchema = z.enum([
  'delhi',
  'noida',
  'gurugram',
  'mumbai',
  'kolkata',
  'bengaluru',
])
export type City = z.infer<typeof citySchema>
export const profileSchema = z.strictObject({
  people: z.enum(['Adults', 'With children', 'With older adults']),
  travel: z.enum([
    'Public transport',
    'Car or two-wheeler',
    'Walk or cycle',
    'Work from home',
  ]),
  period: z.enum(['Morning', 'Afternoon', 'Evening']),
  activity: z.enum(['A walk', 'Outdoor exercise', 'Playtime', 'Errands']),
})
export type Profile = z.infer<typeof profileSchema>
export const defaults: Profile = {
  people: 'Adults',
  travel: 'Public transport',
  period: 'Morning',
  activity: 'A walk',
}

export const hour = 3_600_000
export const timestamp = z
  .number()
  .int()
  .min(Date.UTC(2020, 0))
  .max(Date.UTC(2100, 0))
export const reading = z.number().finite().nonnegative().nullable()
export const hourlySchema = z.object({ time: timestamp, aqi: reading })
export const bulletinSchema = z.object({
  city: citySchema,
  valid: timestamp,
  retrieved: timestamp,
  aqi: reading,
  pm25: reading,
  pm10: reading,
  hours: z.array(hourlySchema).max(120).refine(
    hours => hours.every((point, i) => i === 0 || point.time > hours[i - 1].time),
    'Hourly timestamps must be strictly increasing.',
  ),
  notice: z.enum(['cached', 'rate', 'source']).optional(),
})
export type Bulletin = z.infer<typeof bulletinSchema>
export type Point = z.infer<typeof hourlySchema>
const validAge = 3 * hour
const retrievalAge = hour
const savedAge = 24 * hour
export function stale(b: Bulletin, now: number) {
  return (
    !usable(b, now) || !!b.notice ||
    now - b.valid > validAge ||
    now - b.retrieved > retrievalAge
  )
}
export function usable(b: Bulletin, now: number) {
  return (
    b.valid >= now - savedAge &&
    b.retrieved >= now - savedAge &&
    b.retrieved <= now + 60_000 &&
    b.valid <= now + hour / 2
  )
}

type ModeledReading = {
  kind: 'current' | 'earlier' | 'upcoming' | 'saved'
  time: number
  aqi: number
}

// The latest provider value describes its valid instant. A fresh retrieval
// can confirm that value, but cannot move that instant forward.
export function modeledReading(b: Bulletin | null, now: number): ModeledReading | null {
  if (!b || b.aqi === null || !usable(b, now)) return null
  const kind = stale(b, now) ? 'saved' : b.valid > now ? 'upcoming' :
    now - b.valid < hour ? 'current' : 'earlier'
  return { kind, time: b.valid, aqi: b.aqi }
}
const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', ...opts })
const time = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const date = fmt({ day: 'numeric', month: 'short', year: 'numeric' })
const edition = fmt({
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
export const timeIST = (ms: number) => time.format(ms)
export const dateIST = (ms: number) => date.format(ms)
export const editionIST = (ms: number) => edition.format(ms)
export const stamp = (ms: number) => dateIST(ms) + ' · ' + timeIST(ms) + ' IST'
export const periods = ['Morning', 'Afternoon', 'Evening'] as const
export type Period = (typeof periods)[number]
const bounds: Record<Period, [number, number]> = {
  Morning: [6, 12],
  Afternoon: [12, 17],
  Evening: [17, 22],
}
export const spans: Record<Period, string> = {
  Morning: '06–12',
  Afternoon: '12–17',
  Evening: '17–22',
}
export function periodAt(ms: number): Period | null {
  const h = Number(timeIST(ms).slice(0, 2))
  return periods.find((p) => h >= bounds[p][0] && h < bounds[p][1]) ?? null
}
export function category(value: number) {
  const labels = [
    'Good',
    'Moderate',
    'Unhealthy for sensitive groups',
    'Unhealthy',
    'Very unhealthy',
    'Hazardous',
  ]
  const i = [50, 100, 150, 200, 300].findIndex(
    (max) => Math.round(value) <= max,
  )
  const level = i < 0 ? 5 : i
  return { label: labels[level], level }
}
export type PlanningWindow = { period: Period; start: number; end: number }

// Use the city clock even when the client and the Worker run in other time zones.
export function startOfDayIST(now: number) {
  const [h, m] = timeIST(now).split(':').map(Number)
  return Math.floor(now / 60_000) * 60_000 - h * hour - m * 60_000
}

export function windowsThroughTomorrow(now: number): PlanningWindow[] {
  const midnight = startOfDayIST(now)
  return [midnight, midnight + 24 * hour].flatMap((day) =>
    periods.map((period) => ({
      period,
      start: day + bounds[period][0] * hour,
      end: day + bounds[period][1] * hour,
    })),
  ).filter((w) => w.end > now)
}

export function planningWindows(now: number) {
  return windowsThroughTomorrow(now).slice(0, 3)
}

type ForecastReading = { time: number; aqi: number }
export type WindowForecast = (
  | { low: null; high: null; complete: false }
  | { low: number; high: number; complete: boolean }
) & {
  previous?: ForecastReading
  laterFrom?: number
}

// Hourly US AQI is valid at its timestamp. Keep at most one earlier point
// within one sampling cadence as context, even across a period or date change.
function recentForecast(b: Bulletin, now: number) {
  return b.hours.findLast((p) => p.time <= now && p.time > now - hour)
}

export function earlierForecastText(p: ForecastReading) {
  return 'The earlier forecast for ' + stamp(p.time) + ' was ' +
    p.aqi + ' US AQI (' + category(p.aqi).label + ').'
}

export function windowForecast(
  b: Bulletin | null,
  now: number,
  start: number,
  end: number,
): WindowForecast {
  const from = Math.max(start, now)
  const missing = { low: null, high: null, complete: false } as const
  if (!b || stale(b, now) || from >= end) return missing
  const active = start <= now
  const recent = active ? recentForecast(b, now) : undefined
  const previous = recent && recent.time < start && recent.aqi !== null
    ? { time: recent.time, aqi: recent.aqi }
    : undefined
  const values = b.hours.filter(
    (p): p is { time: number; aqi: number } =>
      p.aqi !== null &&
      p.time >= start &&
      p.time > from - hour &&
      p.time < end,
  )
  if (!values.length) return previous ? { ...missing, previous } : missing
  const first = values[0].time
  // A future period is a broad forecast. Once it starts, the first point
  // can still lie ahead (e.g. 12:30 IST). Only a usable current estimate
  // can bridge that opening offset. It cannot replace a missing grid point.
  const openingOffset = first - hour < start
  const coversStart = first <= from || (openingOffset && (
    !active || modeledReading(b, now)?.kind === 'current'
  ))
  const complete =
    values.length >= 2 &&
    coversStart &&
    values[values.length - 1].time >= end - hour &&
    values.every((v, i) => i === 0 || v.time - values[i - 1].time === hour)
  const readings = values.map((p) => p.aqi)
  return {
    low: Math.min(...readings), high: Math.max(...readings), complete,
    ...(previous && { previous }),
    ...(active && first > now && { laterFrom: first }),
  }
}

export function currentDuring(b: Bulletin | null, w: PlanningWindow, now: number) {
  if (now < w.start || now >= w.end) return null
  const reading = modeledReading(b, now)
  return reading?.kind === 'current' ? reading.aqi : null
}

export function outlookPoints(b: Bulletin | null, now: number, end: number) {
  if (!b || stale(b, now)) return []
  const recent = recentForecast(b, now)
  return b.hours.filter((p) => p.time < end && (p.time >= now || p === recent))
}

export function comparablePeriod(w: PlanningWindow, f: WindowForecast, now: number) {
  if (!f.complete || w.end - Math.max(w.start, now) < comparisonDuration) return false
  // A lower forecast for later in this period cannot establish a lower
  // period for an outing now when the preceding forecast was adverse.
  return !f.previous || category(f.previous.aqi).level < 2 || f.previous.aqi <= f.high
}

const comparisonDuration = 3 * hour

// Update the displayed clock on the minute, or earlier if a source reading,
// freshness limit or supported comparison changes between minute ticks.
export function nextBulletinTick(b: Bulletin | null, now: number) {
  const minute = now - (now % 60_000) + 60_000
  if (!b) return minute
  const deadlines = [
    b.valid, b.valid + hour, b.valid + validAge + 1, b.retrieved + retrievalAge + 1,
    Math.min(b.valid, b.retrieved) + savedAge + 1,
    planningWindows(now)[0].end - comparisonDuration + 1,
    ...b.hours.flatMap((p) => [p.time, p.time + 1, p.time + hour]),
  ]
  return Math.min(minute, ...deadlines.filter((t) => t > now))
}

// A comparison is a regional trend across broad periods. The 25-point
// separation is a conservative display rule, not a health or safety threshold.
const comparisonMargin = 25
export function materiallyLower(higherLow: number, lowerHigh: number) {
  return higherLow - lowerHigh >= comparisonMargin && category(higherLow).level > category(lowerHigh).level
}

export function forecastSummary(b: Bulletin | null, now: number, end: number) {
  if (!b || stale(b, now))
    return 'A fresh hourly forecast is needed to compare periods.'
  const ranges = windowsThroughTomorrow(now).flatMap((w) => {
    if (w.start >= end) return []
    const stop = Math.min(w.end, end)
    const forecast = windowForecast(b, now, w.start, stop)
    const { low, high } = forecast
    if (low === null) return []
    const current = currentDuring(b, w, now)
    const comparable = stop === w.end && (w.start > now || current !== null) &&
      comparablePeriod(w, forecast, now)
    return [{ ...w, low, high, comparable, current, laterFrom: forecast.laterFrom }]
  })
  const label = (w: PlanningWindow) => w.period + ' (' + dateIST(w.start) + ')'
  // Include severe overnight estimates in the outlook. Overnight is outside
  // the household's three outing periods and never becomes a candidate.
  const points = outlookPoints(b, now, end)
  const earlier = points[0]
  let alert = ''
  if (earlier?.time < now && earlier.aqi !== null && category(earlier.aqi).level >= 2 &&
      (category(earlier.aqi).level >= 4 || periodAt(earlier.time) !== periodAt(now))) {
    alert = earlierForecastText({ time: earlier.time, aqi: earlier.aqi }) + ' '
  }
  if (periodAt(now) && modeledReading(b, now)?.kind !== 'current') {
    const active = ranges.find((w) => w.start <= now)
    alert += 'Current modeled US AQI is unavailable. '
    if (active?.laterFrom !== undefined)
      alert += 'The next hourly forecast is for ' + timeIST(active.laterFrom) + ' IST. '
    else alert += 'Recheck before going outdoors. '
  }
  const peak = points.reduce<Point | null>((highest, p) => {
    if (p.time < now || p.aqi === null) return highest
    return highest?.aqi == null || p.aqi > highest.aqi ? p : highest
  }, null)
  if (peak?.aqi != null && category(peak.aqi).level >= 4) {
    alert += (periodAt(peak.time) ?? 'Overnight') + ' (' + dateIST(peak.time) +
      ') includes a ' + category(peak.aqi).label.toLowerCase() +
      ' forecast of ' + Math.round(peak.aqi) + ' US AQI. '
  }
  const covered = ranges.filter((w) => w.comparable)
  if (covered.length < 2)
    return alert + 'There is insufficient coverage to compare two broad periods in this outlook.'
  const conflict = covered.find(({ current, high }) =>
    current !== null && category(current).level >= 2 && current > high,
  )
  if (conflict?.current != null) {
    const { current, high } = conflict
    const differs = category(current).level > category(high).level || current - high >= comparisonMargin
    const warning = differs ? 'The current modeled US AQI is higher than the active period’s forecast. ' : ''
    return alert + warning + 'Recheck conditions before choosing an outing period.'
  }
  const lower = covered.reduce((a, w) => w.high < a.high ? w : a)
  const higher = covered.reduce((a, w) => w.low > a.low ? w : a)
  if (materiallyLower(higher.low, lower.high)) {
    if (category(lower.high).level >= 2)
      return alert + 'Even the lower forecast period reaches ' +
        category(lower.high).label + ' on the US AQI scale.'
    return alert + 'Regional forecasts are lower for ' + label(lower) + ' than for ' +
      label(higher) + '. Local conditions may differ.'
  }
  return alert + 'The regional forecasts show no clear lower period. Local conditions may differ.'
}
export const sourceURL = 'https://open-meteo.com/en/docs/air-quality-api'
