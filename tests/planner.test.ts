import { describe, expect, it } from 'vitest'
import {
  category,
  cities,
  forecastSummary,
  dateIST,
  hour,
  nextBulletinTick,
  periodAt,
  profileSchema,
  stale,
  timeIST,
  usable,
  type Bulletin,
  type Profile,
} from '../src/domain'
import { makePlan } from '../src/plan'
import { boundedJSON, parseProvider, providerURL } from '../worker/provider'

const now = Date.UTC(2026, 10, 23, 2)
const b: Bulletin = {
  city: 'delhi',
  valid: now,
  retrieved: now,
  aqi: 151,
  pm25: 34,
  pm10: 57,
  hours: [],
}
const raw = {
  latitude: 28.7,
  longitude: 77.2,
  current: { time: now / 1000, us_aqi: 151, pm2_5: null, pm10: 57 },
  current_units: {
    time: 'unixtime',
    us_aqi: 'USAQI',
    pm2_5: 'μg/m³',
    pm10: 'μg/m³',
  },
  hourly: { time: [now / 1000], us_aqi: [null] },
  hourly_units: { time: 'unixtime', us_aqi: 'USAQI' },
}
describe('source contract', () => {
  it('preserves source values, nulls and time units', () =>
    expect(parseProvider(raw, 'delhi', now)).toMatchObject({
      ...b,
      pm25: null,
      hours: [{ time: now, aqi: null }],
    }))
  it.each([
    { ...raw, latitude: 8 },
    { ...raw, current_units: { ...raw.current_units, pm10: 'ppm' } },
    { ...raw, current_units: { time: 'unixtime', pm10: 'μg/m³' } },
    { ...raw, hourly: { time: [], us_aqi: [20] } },
    { ...raw, hourly: { time: [now / 1000, now / 1000], us_aqi: [1, 2] } },
    { ...raw, current: { ...raw.current, pm10: -1 } },
    { ...raw, current: { ...raw.current, time: (now - 25 * hour) / 1000 } },
    { ...raw, current: { ...raw.current, time: (now + hour) / 1000 } },
  ])('rejects invalid provider evidence', (value) =>
    expect(() => parseProvider(value, 'delhi', now)).toThrow(),
  )
  it('retains current data without a forecast', () =>
    expect(
      parseProvider({ ...raw, hourly: undefined }, 'delhi', now).hours,
    ).toEqual([]))
  it('uses a fixed host and distinct verified city coordinates', () => {
    const urls = Object.keys(cities).map((c) =>
      providerURL(c as keyof typeof cities),
    )
    expect(new Set(urls.map(String)).size).toBe(6)
    expect(
      urls.every(
        (u) =>
          u.hostname === 'air-quality-api.open-meteo.com' &&
          u.searchParams.get('domains') === 'cams_global',
      ),
    ).toBe(true)
  })
  it('enforces byte limits without content length', async () => {
    await expect(
      boundedJSON(new Response('{"field":"large"}'), 6),
    ).rejects.toThrow(RangeError)
  })
})
describe('local time and index', () => {
  it.each([
    [0, 'Good'],
    [50, 'Good'],
    [51, 'Moderate'],
    [100, 'Moderate'],
    [101, 'Unhealthy for sensitive groups'],
    [150, 'Unhealthy for sensitive groups'],
    [151, 'Unhealthy'],
    [200, 'Unhealthy'],
    [201, 'Very unhealthy'],
    [300, 'Very unhealthy'],
    [301, 'Hazardous'],
  ])('labels %i', (v, label) => expect(category(Number(v)).label).toBe(label))
  it('uses IST across a UTC date boundary', () => {
    const t = Date.UTC(2026, 10, 23, 20)
    expect(dateIST(t)).toBe('24 Nov 2026')
    expect(timeIST(t)).toBe('01:30')
    expect(periodAt(t)).toBeNull()
  })
  it('distinguishes stale from expired and enforces retrieval age', () => {
    expect(stale(b, now)).toBe(false)
    expect(stale({ ...b, valid: now - 4 * hour }, now)).toBe(true)
    expect(stale({ ...b, notice: 'rate' }, now)).toBe(true)
    expect(stale({ ...b, retrieved: now - 2 * hour }, now)).toBe(true)
    expect(usable(b, now + 25 * hour)).toBe(false)
  })
  it('ticks at the first millisecond past model, retrieval and saved-data freshness limits', () => {
    const boundary = now + 12_345
    const source = { ...b, valid: boundary - 3 * hour }
    const retrieval = { ...b, retrieved: boundary - hour }
    for (const data of [source, retrieval]) {
      expect(stale(data, boundary)).toBe(false)
      expect(nextBulletinTick(data, boundary)).toBe(boundary + 1)
      expect(stale(data, boundary + 1)).toBe(true)
    }
    const saved = { ...b, valid: boundary - 24 * hour }
    expect(usable(saved, boundary)).toBe(true)
    expect(nextBulletinTick(saved, boundary)).toBe(boundary + 1)
    expect(usable(saved, boundary + 1)).toBe(false)
  })
  it('ticks when the current source hour and a broad comparison window end', () => {
    const sampleEnds = now + 7_000
    expect(nextBulletinTick({ ...b, valid: sampleEnds - hour }, now)).toBe(sampleEnds)
    const nineIST = Date.parse('2026-11-23T09:00:00+05:30')
    expect(nextBulletinTick(b, nineIST)).toBe(nineIST + 1)
  })
})
// The provider's UTC-hour grid lands on :30 in India. Keep the input times
// independent of the planner's period/date helpers in these decision tests.
const morning = Date.parse('2026-11-23T07:30:00+05:30')
const afternoon = Date.parse('2026-11-23T12:30:00+05:30')
const evening = Date.parse('2026-11-23T17:30:00+05:30')
const play: Profile = {
  people: 'With children',
  period: 'Afternoon',
  activity: 'Playtime',
  travel: 'Walk or cycle',
}
function series(first: number, values: (number | null)[]) {
  return values.map((aqi, i) => ({ time: first + i * hour, aqi }))
}
function bulletin(
  current: number,
  hours: Bulletin['hours'],
  at = morning,
): Bulletin {
  return { ...b, aqi: current, valid: at, retrieved: at, hours }
}
function outing(data: Bulletin | null, p = play, at = morning) {
  const rows = makePlan(data, p, at).filter((a) => a.kind === 'outing')
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('decisions for the selected outing', () => {
  it('moves play indoors for an afternoon forecast of 352–355 after a morning reading of 55', () => {
    const data = bulletin(55, series(afternoon, [352, 353, 355, 354, 352]))
    const action = outing(data)
    expect(action.period).toBe('Afternoon')
    expect(action.title).toMatch(/indoor|postpone/i)
    expect(action.title).not.toMatch(/break|shorter/i)
    expect(action.reason).toMatch(/hazardous/i)
    expect(action.reason).toMatch(/US AQI/)
    expect(action.forecast).toMatchObject({
      low: 352,
      high: 355,
      complete: true,
    })
  })

  it('uses a sustained improvement for a future outing, even when the current AQI is hazardous', () => {
    const data = bulletin(352, series(afternoon, [41, 42, 43, 44, 45]))
    const action = outing(data)
    expect(action.title).toMatch(/play/i)
    expect(action.title).not.toMatch(/indoor|postpone|avoid/i)
    expect(action.forecast).toMatchObject({ low: 41, high: 45, complete: true })
    expect(action.reason).toMatch(/forecast|model/i)
    expect(action.reason).not.toMatch(/\bsafe\b/i)
  })

  it('accounts for a sharp deterioration inside the window instead of choosing its cleanest hour', () => {
    const data = bulletin(55, series(afternoon, [55, 65, 180, 305, 340]))
    const action = outing(data, {
      ...play,
      people: 'Adults',
      activity: 'Outdoor exercise',
    })
    expect(action.title).toMatch(/indoor|postpone|avoid/i)
    expect(action.reason).toMatch(/hazardous/i)
    expect(action.forecast.high).toBe(340)
  })

  it('keeps evidence from already elapsed hours out of an in-progress outing', () => {
    const at = Date.parse('2026-11-23T14:45:00+05:30')
    const data = bulletin(45, series(afternoon, [340, 340, 45, 46, 47]), at)
    const action = outing(data, play, at)
    expect(action.forecast).toMatchObject({ low: 45, high: 47, complete: true })
    expect(action.title).not.toMatch(/indoor|postpone/i)
    expect(action.reason).not.toMatch(/hazardous/i)
  })

  it.each(['null', 'absent'])(
    'requires the active hourly slot when the 14:30 estimate is %s at 14:45',
    (missing) => {
      const at = Date.parse('2026-11-23T14:45:00+05:30')
      const hours = series(afternoon, [40, 40, null, 40, 40])
      const data = bulletin(
        40,
        missing === 'null' ? hours : hours.filter((p) => p.aqi !== null),
        at,
      )
      const action = outing(data, play, at)
      expect(action.forecast).toMatchObject({
        low: 40,
        high: 40,
        complete: false,
      })
      expect(action.title).toMatch(/recheck/i)
      expect(action.title).not.toMatch(/breaks/i)
    },
  )

  it('retains the current hazardous warning when an outing is already underway', () => {
    const at = Date.parse('2026-11-23T14:45:00+05:30')
    const data = bulletin(352, series(afternoon, [40, 41, 42, 43, 44]), at)
    const action = outing({ ...data, valid: at - 15 * 60_000 }, play, at)
    expect(action.title).toMatch(/indoor/i)
    expect(action.reason).toMatch(/current.*352.*hazardous/i)
  })

  it('keeps the latest hazardous reading at the start of a new local period', () => {
    const at = Date.parse('2026-11-23T12:05:00+05:30')
    const data = {
      ...bulletin(
        352,
        [
          ...series(afternoon, [41, 42, 43, 44, 45]),
          ...series(evening, [160, 161, 162, 163, 164]),
        ],
        at,
      ),
      valid: Date.parse('2026-11-23T11:30:00+05:30'),
    }
    // The provider's next hourly value is still 25 minutes away.
    const action = outing(data, play, at)
    expect(action.title).toMatch(/indoor/i)
    expect(action.reason).toMatch(/current.*352.*hazardous/i)
    const summary = forecastSummary(data, at, evening + 4.5 * hour)
    expect(summary).not.toMatch(/lower for afternoon|afternoon.{0,40}is lower/i)
  })

  it('reserves the selected evening for play even when the afternoon forecast is better', () => {
    const data = bulletin(55, [
      ...series(afternoon, [35, 36, 37, 38, 39]),
      ...series(evening, [310, 320, 330, 340, 350]),
    ])
    const plan = makePlan(data, { ...play, period: 'Evening' }, morning)
    // The earlier planner silently put the activity in the afternoon and
    // reserved the selected period for transport alone.
    expect(
      plan.filter((a) => a.kind === 'outing').map((a) => a.period),
    ).toEqual(['Evening'])
    const eveningOuting = plan.find((a) => a.period === 'Evening')!
    expect(eveningOuting.title).toMatch(/indoor|postpone/i)
    expect(eveningOuting.reason).toMatch(/hazardous/i)
  })

  it.each([
    ['missing forecast', bulletin(45, [])],
    ['single low estimate', bulletin(45, series(afternoon, [40]))],
    [
      'missing middle hour',
      bulletin(45, series(afternoon, [42, 43, null, 45, 46])),
    ],
    [
      'stale retrieval',
      {
        ...bulletin(45, series(afternoon, [40, 41, 42, 43, 44])),
        retrieved: morning - 2 * hour,
      },
    ],
  ])('asks for another check with %s', (_case, data) => {
    const action = outing(data as Bulletin)
    expect(action.forecast.complete).toBe(false)
    expect(action.title + ' ' + action.reason).toMatch(
      /check|uncertain|insufficient|incomplete|missing/i,
    )
    expect(action.title).not.toMatch(/breaks|go ahead|head outside/i)
    expect(action.reason).not.toMatch(/best (time|hour)|safer at|safe to/i)
  })

  it('retains a hazardous warning even when the rest of that period is unavailable', () => {
    const action = outing(
      bulletin(55, series(afternoon, [null, 355, null, null, null])),
    )
    expect(action.forecast.complete).toBe(false)
    expect(action.title).toMatch(/indoor|postpone|avoid/i)
    expect(action.reason).toMatch(/hazardous/i)
  })

  it('preserves household-specific guidance on the same forecast', () => {
    const data = bulletin(55, series(afternoon, [70, 71, 72, 73, 74]))
    const family = outing(data)
    const older = outing(data, {
      ...play,
      people: 'With older adults',
      activity: 'Errands',
      travel: 'Car or two-wheeler',
    })
    expect(family.title + ' ' + family.reason).toMatch(/play/i)
    expect(older.title + ' ' + older.reason).toMatch(/errand|stops/i)
    expect(family.title).not.toBe(older.title)
    expect(
      profileSchema.safeParse({ ...play, people: 'arbitrary input' }).success,
    ).toBe(false)
  })

  it('accounts for household sensitivity at US AQI 101 for the same activity and time', () => {
    const data = bulletin(55, series(afternoon, [101, 101, 101, 101, 101]))
    const exercise: Profile = { ...play, activity: 'Outdoor exercise' }
    const childHousehold = outing(data, exercise)
    const adultHousehold = outing(data, { ...exercise, people: 'Adults' })
    expect(childHousehold.title).toMatch(/indoor/i)
    expect(childHousehold.reason).toMatch(/unhealthy for sensitive groups/i)
    expect(adultHousehold.title).not.toMatch(/indoor|postpone/i)
    expect(adultHousehold.forecast).toEqual(childHousehold.forecast)
  })
})

describe('forecast comparisons', () => {
  it('keeps a conservative comparison when the current estimate barely exceeds the forecast high', () => {
    const at = afternoon - hour / 2
    const data = bulletin(155, [
      ...series(afternoon, Array(5).fill(154.5)),
      ...series(evening, Array(5).fill(352)),
    ], at)
    const summary = forecastSummary(data, at, evening + 4.5 * hour)
    expect(summary).toMatch(/hazardous/i)
    expect(summary).toMatch(/recheck/i)
    expect(summary).not.toMatch(/higher than|lower for/i)
  })

  it.each([
    ['within one category', 153, 155],
    ['across a category boundary', 150, 151],
  ])('suppresses near-ties %s', (_case, a, c) => {
    const low = Number(a),
      high = Number(c)
    const hours = [
      ...series(afternoon, Array(5).fill(low)),
      ...series(evening, Array(5).fill(high)),
    ]
    const data = bulletin(low, hours, afternoon - hour / 2)
    // The former comparison promoted even a one-point change and selected
    // an exact clock time without evidence for a material difference.
    const summary = forecastSummary(
      data,
      afternoon - hour / 2,
      evening + 4.5 * hour,
    )
    expect(summary).toMatch(/no clear lower|similar|little difference/i)
    expect(summary).not.toMatch(
      /lowest estimate|is lower than|lower (?:at|than)|safest|best time|\d{2}:\d{2}/i,
    )
  })

  it('describes clearly separated categories at period resolution without suggesting a precise departure', () => {
    const at = afternoon - hour / 2
    const data = bulletin(
      51,
      [
        ...series(afternoon, [51, 54, 52, 52, 51]),
        ...series(evening, [352, 355, 352, 353, 352]),
      ],
      at,
    )
    const summary = forecastSummary(data, at, evening + 4.5 * hour)
    expect(summary).toMatch(/lower.{0,50}afternoon/i)
    expect(summary).toMatch(/evening/i)
    expect(summary).toMatch(/hazardous/i)
    expect(summary).not.toMatch(/\d{2}:\d{2}|safest|best hour/i)
  })

  it('warns when even the lower broad period is unhealthy', () => {
    const at = afternoon - hour / 2
    const data = bulletin(
      155,
      [
        ...series(afternoon, [153, 154, 155, 154, 153]),
        ...series(evening, [352, 355, 352, 353, 352]),
      ],
      at,
    )
    const summary = forecastSummary(data, at, evening + 4.5 * hour)
    expect(summary).toMatch(/unhealthy/i)
    expect(summary).toMatch(/hazardous/i)
    expect(summary).not.toMatch(
      /lower for afternoon|afternoon.{0,40}is lower|best hour/i,
    )
  })
})

describe('India-local schedule boundaries', () => {
  const tonight = Date.parse('2026-11-23T22:30:00+05:30')
  const nextMidnight = Date.parse('2026-11-24T00:00:00+05:30')
  const nextMorning = Date.parse('2026-11-24T06:30:00+05:30')
  const supported = series(nextMorning, [301, 302, 303, 304, 305, 306])

  it.each([tonight, nextMidnight])(
    'leads with the supported next morning at %i',
    (at) => {
      const data = bulletin(45, supported, at)
      const plan = makePlan(data, { ...play, period: 'Morning' }, at)
      expect(plan[0]).toMatchObject({ period: 'Morning', kind: 'outing' })
      expect(plan[0].start).toBe(Date.parse('2026-11-24T06:00:00+05:30'))
      expect(plan.every((a) => a.end > at)).toBe(true)
      expect(plan[0].title).toMatch(/indoor|postpone/i)
      expect(plan[0].reason).toMatch(/hazardous/i)
    },
  )

  it('does not carry yesterday’s forecast into an unsupported next-day window', () => {
    const oldHours = series(nextMorning - 24 * hour, [35, 36, 37, 38, 39, 40])
    const action = outing(
      bulletin(40, oldHours, tonight),
      { ...play, period: 'Morning' },
      tonight,
    )
    expect(action.start).toBeGreaterThan(tonight)
    expect(action.forecast).toMatchObject({
      complete: false,
      low: null,
      high: null,
    })
    expect(action.title + ' ' + action.reason).toMatch(
      /check|uncertain|unavailable|incomplete/i,
    )
  })
})
