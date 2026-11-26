import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDecision } from '../src/choices'
import { forecastSummary, outlookPoints, type Bulletin, type Period, type Profile } from '../src/domain'
import { decisionContext, evidenceRevision, resolveExplanation } from '../src/explanationFacts'
import { explanationSchema } from '../src/contracts'
import { route } from '../worker/index'

const hourMs = 3_600_000
const ist = (clock: string, day = '2026-11-24') => Date.parse(day + 'T' + clock + '+05:30')
const children: Profile = {
  people: 'With children', activity: 'Playtime', period: 'Afternoon', travel: 'Work from home',
}
const later = [
  { time: ist('12:30'), aqi: 80 }, { time: ist('13:30'), aqi: 75 },
  { time: ist('14:30'), aqi: 70 }, { time: ist('15:30'), aqi: 65 },
  { time: ist('16:30'), aqi: 60 },
]
const earlier = { time: ist('11:30'), aqi: 352 }
const noonCheck = ist('12:05')

function bulletin(hours: Bulletin['hours'], now = noonCheck, current: number | null = null): Bulletin {
  return { city: 'delhi', valid: now, retrieved: now, pm25: null, pm10: null, aqi: current, hours }
}
function outing(data: Bulletin, now = noonCheck, period: Period = 'Afternoon') {
  return makeDecision(data, { ...children, period }, now).outing
}

describe('12:05 IST with improving hourly estimates', () => {
  it('keeps the 11:30 forecast visible and advises caution without assigning 352 to now or the afternoon', () => {
    const data = bulletin([earlier, ...later])
    const row = outing(data)
    expect(row.start).toBe(ist('12:00'))
    expect(row.title).toMatch(/recheck|indoor|postpone|wait/i)
    expect(row.reason).toContain('11:30')
    expect(row.reason).toContain('352')
    expect(row.reason).not.toMatch(/current (?:modeled )?US AQI is 352|afternoon forecast is [^.]*352|currently hazardous/i)
    const end = ist('17:00')
    expect(outlookPoints(data, noonCheck, end)).toEqual([earlier, ...later])
    const summary = forecastSummary(data, noonCheck, end)
    expect(summary).toMatch(/11:30/)
    expect(summary).toMatch(/hazardous/i)
    const decision = makeDecision(data, children, noonCheck)
    expect(decision.recommended.id).toMatch(/^(indoor|recheck)$/)
    expect(decision.alternative).toBeNull()
  })

  it.each(['missing', 'null'] as const)('withholds outdoor play when the 11:30 value is %s', (kind) => {
    const hours = kind === 'null' ? [{ ...earlier, aqi: null }, ...later] : later
    const data = bulletin(hours)
    const row = outing(data)
    expect(row.title).toMatch(/recheck|wait|postpone/i)
    expect(row.reason).toMatch(/later|from 12:30|start(?:s|ing)? at 12:30/i)
    expect(row.reason).not.toMatch(/hazardous|352/i)
    const decision = makeDecision(data, children, noonCheck)
    expect(decision.recommended.id).toBe('recheck')
    expect(decision.alternative).toBeNull()
    expect(outlookPoints(data, noonCheck, ist('17:00')).filter((p) => p.aqi !== null)).toEqual(later)
  })

  it('keeps the current 352 advisory even when all future afternoon samples are moderate', () => {
    const data = { ...bulletin(later, noonCheck, 352), valid: ist('11:30') }
    const row = outing(data)
    expect(row.title).toMatch(/indoor/i)
    expect(row.caution).toBe(true)
    expect(row.reason).toMatch(/current.*352.*hazardous/i)
    expect(makeDecision(data, children, noonCheck).recommended.id).toBe('indoor')
  })

  it('keeps the protective choice when a lower current estimate conflicts with the recent hazardous forecast', () => {
    const data = bulletin([earlier, ...later], noonCheck, 75)
    const decision = makeDecision(data, children, noonCheck)
    expect(decision.outing.caution).toBe(true)
    expect(decision.recommended.id).toBe('indoor')
    expect(decision.alternative?.canLead).toBeFalsy()
    expect(decision.basis).toContain('11:30')
    expect(decision.basis).toContain('352')
    expect(decision.basis).not.toMatch(/current (?:modeled )?US AQI is 352|currently hazardous/i)
  })

  it('requires evidence for the present even when both the previous and later forecasts are moderate', () => {
    const data = bulletin([{ ...earlier, aqi: 70 }, ...later])
    const gap = outing(data)
    expect(gap.title).toMatch(/recheck|wait|postpone/i)
    expect(makeDecision(data, children, noonCheck).alternative).toBeNull()
    const withCurrent = { ...data, aqi: 75 }
    const supported = outing(withCurrent)
    expect(supported.title).toMatch(/breaks into playtime/i)
    expect(supported.forecast).toMatchObject({ low: 60, high: 80, complete: true })
    const missingHour = { ...withCurrent, hours: withCurrent.hours.filter((p) => p.time !== ist('14:30')) }
    expect(outing(missingHour).title).toMatch(/recheck|wait|postpone/i)
  })

  it('retains a broad in-period forecast while asking for current conditions before playtime', () => {
    const now = ist('12:35')
    const data = bulletin([earlier, ...later], now)
    const row = outing(data, now)
    expect(row.title).toMatch(/recheck|check.*condition/i)
    expect(row.reason).toMatch(/forecast/i)
    expect(row.reason).not.toMatch(/current (?:modeled )?US AQI is \d+|352|hazardous/i)
    expect(row.forecast).toMatchObject({ low: 60, high: 80, complete: true })
  })

  it('keeps a later hazardous sample protective even with the present uncovered and an internal gap', () => {
    const data = bulletin([later[0], { time: ist('14:30'), aqi: 366 }, later[4]])
    const row = outing(data)
    expect(row.title).toMatch(/indoor/i)
    expect(row.caution).toBe(true)
    expect(row.reason).toContain('366')
    expect(row.reason).not.toMatch(/current (?:modeled )?US AQI is 366|currently hazardous/i)
    expect(makeDecision(data, children, noonCheck).recommended.id).toBe('indoor')
  })

  it('ignores stale hourly evidence, including the preceding adverse sample', () => {
    const data = { ...bulletin([earlier, ...later]), retrieved: ist('10:00') }
    expect(outing(data).title).toMatch(/recheck/i)
    expect(outing(data).reason).not.toMatch(/352|60–80/)
    expect(outlookPoints(data, noonCheck, ist('17:00'))).toEqual([])
    expect(makeDecision(data, children, noonCheck).alternative).toBeNull()
  })
})

// Product periods start on whole IST hours; these source timestamps are half
// past the hour. The expected transition times are specified independently.
const starts = [
  { period: 'Morning', start: '06:00', previous: '05:30', first: '06:30', count: 6 },
  { period: 'Afternoon', start: '12:00', previous: '11:30', first: '12:30', count: 5 },
  { period: 'Evening', start: '17:00', previous: '16:30', first: '17:30', count: 5 },
] as const

describe.each(starts)('$period at $start IST', ({ period, start, previous, first, count }) => {
  const before = { time: ist(previous), aqi: 352 }
  const firstTime = ist(first)
  const hours = [
    before, ...Array.from({ length: count }, (_, i) => ({ time: firstTime + i * hourMs, aqi: 78 })),
  ]
  it('shows the adjacent forecast on either side of the period boundary and until the next sample', () => {
    const startTime = ist(start)
    for (const now of [startTime - 1, startTime, startTime + 1, firstTime - 1]) {
      const data = bulletin(hours, now)
      expect(outlookPoints(data, now, firstTime + hourMs)[0]).toEqual(before)
      const row = outing(data, now, period)
      expect(row.start).toBe(startTime)
      if (now >= startTime) {
        expect(row.title).toMatch(/recheck|indoor|postpone|wait/i)
        expect(row.reason).toContain(previous)
        expect(row.reason).toContain('352')
      }
    }
  })
  it('recognizes moderate conditions at and after the new sample with a matching current model estimate', () => {
    for (const now of [firstTime, firstTime + 1, firstTime + 5 * 60_000]) {
      const data = { ...bulletin(hours, now, 78), valid: firstTime }
      const row = outing(data, now, period)
      expect(row.caution).toBe(false)
      expect(row.title).toMatch(/breaks into playtime/i)
      expect(row.reason).toMatch(/78 US AQI.*Moderate/i)
      expect(row.reason).not.toMatch(/352|hazardous/i)
      expect(outlookPoints(data, now, firstTime + hourMs)[0]).toEqual(hours[1])
    }
  })
})

it('retains the dated 23:30 point across midnight without applying it to the following morning', () => {
  const previous = { time: ist('23:30'), aqi: 352 }
  const midnight = ist('00:00', '2026-11-25')
  const next = { time: ist('00:30', '2026-11-25'), aqi: 70 }
  const morning = ist('06:30', '2026-11-25')
  const hours = [previous, next, ...Array.from({ length: 6 }, (_, i) => ({ time: morning + i * hourMs, aqi: 75 }))]
  for (const now of [midnight - 1, midnight, midnight + 1, next.time - 1]) {
    const data = bulletin(hours, now)
    expect(outlookPoints(data, now, next.time + 1)).toEqual([previous, next])
    const row = outing(data, now, 'Morning')
    expect(row.start).toBe(ist('06:00', '2026-11-25'))
    expect(row.reason).not.toMatch(/352|hazardous/i)
  }
  expect(outlookPoints(bulletin(hours, next.time), next.time, next.time + 1)).toEqual([next])
})

afterEach(() => vi.useRealTimers())

describe('client and Worker agreement with boundary evidence', () => {
  async function request(air: Bulletin, now = noonCheck) {
    const decision = makeDecision(air, children, now)
    const context = decisionContext(air, children, decision, now)
    return new Request('https://local.test/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: air.city, valid: air.valid, retrieved: air.retrieved, profile: children,
        revision: await evidenceRevision(context),
      }),
    })
  }

  it('accepts the stale display’s no-evidence revision for an active outing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(noonCheck)
    const stale = { ...bulletin([earlier, ...later]), retrieved: ist('10:00') }
    const decision = makeDecision(null, children, noonCheck)
    expect(makeDecision(stale, children, noonCheck)).toEqual(decision)
    const context = decisionContext(null, children, decision, noonCheck)
    const req = new Request('https://local.test/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'delhi', profile: children, valid: null, retrieved: null,
        revision: await evidenceRevision(context) }),
    })
    const load = vi.fn()
    const response = await route(req, {}, load)
    expect(response.status).toBe(200)
    const answer = explanationSchema.parse(await response.json())
    expect(answer.mode).toBe('rules')
    const view = resolveExplanation(answer, decision, context)
    expect(view.recommended.title).toMatch(/recheck/i)
    expect(view.alternative).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it.each([null, 75])('returns only rules for the uncovered present with a current field of %s', async (aqi) => {
    vi.useFakeTimers()
    vi.setSystemTime(noonCheck)
    // A two-hour-old value remains on the bulletin but cannot attest to the current outing.
    const data = { ...bulletin(later, noonCheck, aqi), valid: ist('10:05') }
    const run = vi.fn(async () => { throw Error('No supported comparison') })
    const limit = vi.fn(async () => ({ success: true }))
    const response = await route(await request(data), { AI: { run }, EXPLANATIONS: { limit } }, async () => ({ data }))
    expect(response.status).toBe(200)
    const answer = explanationSchema.parse(await response.json())
    expect(answer.mode).toBe('rules')
    const decision = makeDecision(data, children, noonCheck)
    const view = resolveExplanation(answer, decision, decisionContext(data, children, decision, noonCheck))
    expect(view.recommended.title).toMatch(/recheck|wait|postpone/i)
    expect(view.alternative).toBeNull()
    expect(limit).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects the old decision when only the preceding point is revised to hazardous', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(noonCheck)
    const displayed = bulletin([{ ...earlier, aqi: 75 }, ...later])
    const corrected = { ...displayed, hours: [earlier, ...later] }
    const run = vi.fn()
    const limit = vi.fn(async () => ({ success: true }))
    const env = { AI: { run }, EXPLANATIONS: { limit } }
    const load = async () => ({ data: corrected })
    expect((await route(await request(displayed), env, load)).status).toBe(409)
    const result = await route(await request(corrected), env, load)
    expect(result.status).toBe(200)
    const answer = explanationSchema.parse(await result.json())
    const decision = makeDecision(corrected, children, noonCheck)
    const view = resolveExplanation(answer, decision, decisionContext(corrected, children, decision, noonCheck))
    expect(view.recommended.title).toMatch(/indoor|recheck|wait/i)
    expect(decision.basis).toContain('352')
    expect(limit).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an earlier revision at the first afternoon sample even when source timestamps are unchanged', async () => {
    const transition = ist('12:30')
    const data = bulletin([earlier, ...later])
    vi.useFakeTimers()
    vi.setSystemTime(transition)
    const load = async () => ({ data })
    expect((await route(await request(data, transition - 1), {}, load)).status).toBe(409)
    const result = await route(await request(data, transition), {}, load)
    expect(result.status).toBe(200)
    const decision = makeDecision(data, children, transition)
    const answer = explanationSchema.parse(await result.json())
    expect(answer.mode).toBe('rules')
    const view = resolveExplanation(answer, decision, decisionContext(data, children, decision, transition))
    expect(view.recommended.title).toMatch(/recheck|check.*condition/i)
    expect(decision.basis).not.toMatch(/352|hazardous/i)
  })
})
