import { describe, expect, it } from 'vitest'
import { makeDecision, makeHouseholdPlan, type HouseholdDecision } from '../src/choices'
import { hour, type Bulletin, type Profile } from '../src/domain'
import { makePlan } from '../src/plan'

const now = Date.parse('2026-11-24T08:30:00+05:30')
const afternoon = Date.parse('2026-11-24T12:30:00+05:30')
const evening = Date.parse('2026-11-24T17:30:00+05:30')
const family: Profile = {
  people: 'With children', activity: 'Playtime', period: 'Afternoon', travel: 'Work from home',
}
const older: Profile = {
  people: 'With older adults', activity: 'Errands', period: 'Evening', travel: 'Car or two-wheeler',
}
function period(first: number, readings: (number | null)[]) {
  return readings.map((aqi, i) => ({ time: first + i * hour, aqi }))
}
function bulletin(hours: Bulletin['hours'], at = now): Bulletin {
  return { city: 'bengaluru', valid: at, retrieved: at, aqi: 55, pm25: null, pm10: null, hours }
}
const hazardous = period(afternoon, [352, 353, 355, 354, 352])
const lower = period(evening, [55, 54, 53, 56, 52])
const contrast = bulletin([...hazardous, ...lower])
function goals(d: HouseholdDecision, option?: string) {
  return d.evidence.filter((e) => e.option === option && e.role === 'fit').map((e) => e.id)
}

describe('household plan and selected outing', () => {
  const allPeriods = bulletin([...period(now, [55, 55, 55, 55]), ...hazardous, ...lower])
  it.each([
    ['another household’s evening errands', makePlan(contrast, older, now)],
    ['an empty timeline', []],
    ['a malformed outing', [{ kind: 'outing' }]],
  ] as const)('uses the household inputs when JavaScript passes %s as a fourth argument', (_, unrelated) => {
    // @ts-expect-error A caller can supply only the bulletin, household and instant.
    const decision = makeDecision(contrast, family, now, unrelated)
    expect(decision.outing).toMatchObject({
      period: 'Afternoon', kind: 'outing', title: 'Move playtime indoors', caution: true,
    })
    expect(decision.recommended.id).toBe('indoor')
    expect(decision.basis).toContain('352–355 US AQI (Hazardous')
  })

  it.each([
    ['Morning', '06:00', 'Build breaks into playtime'],
    ['Afternoon', '12:00', 'Move playtime indoors'],
    ['Evening', '17:00', 'Build breaks into playtime'],
  ] as const)('selects the %s action from the timeline it returns', (period, start, title) => {
    const { timeline, decision } = makeHouseholdPlan(allPeriods, { ...family, period }, now)
    expect(timeline.map(row => row.period)).toEqual(['Morning', 'Afternoon', 'Evening'])
    expect(timeline.filter(row => row.kind === 'outing')).toHaveLength(1)
    expect(decision.outing).toBe(timeline.find(row => row.period === period))
    expect(decision.outing).toMatchObject({
      title, start: Date.parse('2026-11-24T' + start + ':00+05:30'),
    })
  })

  it.each([
    ['2026-11-24T23:59:59+05:30', null],
    ['2026-11-25T00:00:00+05:30', contrast],
  ] as const)('keeps the dated morning outing without usable evidence at %s', (instant, data) => {
    const { timeline, decision } = makeHouseholdPlan(data, { ...family, period: 'Morning' }, Date.parse(instant))
    expect(decision.outing).toBe(timeline[0])
    expect(decision.outing).toMatchObject({
      start: Date.parse('2026-11-25T06:00:00+05:30'), title: 'Recheck the forecast before playtime',
      forecast: { complete: false, low: null, high: null },
    })
    expect(decision.alternative).toBeNull()
  })

  it('rejects an invalid outing period explicitly', () => {
    // @ts-expect-error Exercise an unchecked JavaScript caller.
    expect(() => makeHouseholdPlan(contrast, { ...family, period: 'Overnight' }, now))
      .toThrow('No outing for the selected household period')
  })
})

describe('feasible household choices', () => {
  it('keeps hazardous afternoon play indoors and offers only the independently covered lower evening for outdoor play', () => {
    const d = makeDecision(contrast, family, now)
    expect(d.recommended.title).toMatch(/playtime indoors/i)
    expect(d.alternative?.title).toMatch(/playtime outdoors in the evening on 24 Nov 2026/i)
    expect(d.alternative?.canLead).toBeFalsy()
    expect(d.basis).toMatch(/Afternoon · 24 Nov 2026/)
    expect(d.basis).toMatch(/352–355 US AQI \(Hazardous/)
    expect(d.basis).toMatch(/52–56 US AQI \(Moderate/)
    expect(goals(d, d.recommended.id)).toContain('keeps-period')
    expect(goals(d, d.recommended.id)).toContain('at-home')
    expect(goals(d, d.alternative?.id)).toContain('keeps-outdoor-activity')
    expect(d.evidence).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/no indoor air measurement/i) }))
  })

  it('offers a materially different evening decision for older adults doing vehicle errands on the same bulletin', () => {
    const d = makeDecision(contrast, older, now)
    expect(d.recommended.title).toBe('Keep the errand list short')
    expect(d.alternative?.title).toMatch(/combine necessary stops if they fit/i)
    expect(d.basis).toMatch(/Evening · 24 Nov 2026/)
    expect(d.basis).toMatch(/52–56 US AQI/)
    expect(d.basis).not.toMatch(/hazardous|352/i)
    expect(goals(d, d.recommended.id)).toContain('return-after-priority-stop')
    expect(goals(d, d.alternative?.id)).toContain('avoids-extra-trip')
    expect(d.evidence.filter((e) => e.role === 'tradeoff' && e.option === d.recommended.id)
      .map((e) => e.text)).toEqual(expect.arrayContaining([
        expect.stringMatching(/remaining errands would wait/i),
        expect.stringMatching(/could mean a separate vehicle trip/i),
      ]))
  })

  it('uses household and travel preferences independently when they affect the choice', () => {
    const adults = makeDecision(contrast, { ...older, people: 'Adults' }, now)
    expect(adults.recommended.title).toMatch(/combine necessary stops if/i)
    expect(adults.alternative?.title).toMatch(/list short/i)
    const transit = makeDecision(contrast, { ...older, travel: 'Public transport' }, now)
    expect(transit.recommended.title).toMatch(/departures/i)
    expect(transit.alternative).toBeNull()
    expect(goals(transit, transit.recommended.id)).not.toContain('avoids-extra-trip')
    const commute = makeDecision(contrast, { ...family, travel: 'Walk or cycle' }, now)
    expect(goals(commute, commute.recommended.id)).not.toContain('at-home')
  })

  it('states the necessity condition whenever an outing during an advisory is mentioned', () => {
    const d = makeDecision(contrast, { ...older, period: 'Afternoon' }, now)
    expect(d.recommended.title).toMatch(/postpone optional/i)
    expect(d.alternative?.title).toMatch(/^if a stop cannot wait.*essential trip brief/i)
    expect(d.alternative?.canLead).toBeFalsy()
    expect(d.basis).toMatch(/hazardous/i)
    expect(d.evidence.every((e) => e.id !== 'avoids-extra-trip')).toBe(true)
  })

  it.each([
    ['missing middle sample', [45, 45, null, 45, 45]],
    ['still unsuitable for children', [101, 102, 100, 100, 101]],
    ['isolated lower hour', [352, 355, 45, 354, 352]],
  ])('does not offer a later outdoor period with a %s', (_name, values) => {
    const d = makeDecision(bulletin([...hazardous, ...period(evening, values as (number | null)[])]), family, now)
    expect(d.recommended.title).toMatch(/playtime indoors/i)
    expect(d.alternative).toBeNull()
  })

  it('does not use a category boundary near-tie to propose changing the outing time', () => {
    const data = bulletin([...period(afternoon, [103, 103, 103, 103, 103]), ...period(evening, [99, 99, 99, 99, 99])])
    const d = makeDecision(data, family, now)
    expect(d.recommended.title).toMatch(/indoors/i)
    expect(d.alternative).toBeNull()
  })

  it('distinguishes time from setting when both feasible options are outdoors', () => {
    const data = bulletin([...period(afternoon, [83, 84, 82, 83, 85]), ...period(evening, [42, 42, 43, 42, 42])])
    const d = makeDecision(data, family, now)
    expect(goals(d, d.recommended.id)).toEqual(['keeps-period'])
    expect(goals(d, d.alternative?.id)).toEqual(['lower-period'])
    expect(d.alternative?.title).toMatch(/outdoors.*evening/i)
  })

  it('compares settings within the same period without treating the shared time as a differentiator', () => {
    const d = makeDecision(bulletin(lower), { ...family, period: 'Evening' }, now)
    expect(d.recommended.title).toMatch(/breaks into playtime/i)
    expect(d.alternative?.title).toMatch(/playtime indoors/i)
    expect(d.alternative?.canLead).toBe(true)
    expect(goals(d, d.alternative?.id)).not.toContain('keeps-period')
    expect(goals(d, d.alternative?.id)).toContain('smoke-free-play')
  })

  it('retains partial adverse evidence without pairing it with a favorable later comparison', () => {
    const d = makeDecision(bulletin([...period(afternoon, [352, null, null, null, null]), ...lower]), family, now)
    expect(d.recommended.title).toMatch(/indoors/i)
    expect(d.basis).toMatch(/hazardous/i)
    expect(d.basis).toMatch(/incomplete/i)
    expect(d.alternative).toBeNull()
  })

  it.each([null, bulletin(lower), { ...contrast, retrieved: now - 2 * hour }])(
    'gives one recheck action when evidence for the selected period is missing or stale', (b) => {
      const d = makeDecision(b, family, now)
      expect(d.recommended.title).toMatch(/recheck/i)
      expect(d.alternative).toBeNull()
      expect(d.basis).not.toMatch(/352|55 US AQI/)
    },
  )

  it('uses dated next-day periods after the last outing slot and never reuses earlier estimates', () => {
    const late = Date.parse('2026-11-24T22:30:00+05:30')
    const morning = Date.parse('2026-11-25T06:30:00+05:30')
    const data = bulletin([...lower, ...period(morning, [352, 352, 353, 354, 355, 352]),
      ...period(afternoon + 24 * hour, [51, 53, 54, 55, 56])], late)
    const d = makeDecision(data, { ...family, period: 'Morning' }, late)
    expect(d.basis).toMatch(/Morning · 25 Nov 2026/)
    expect(d.alternative?.title).toMatch(/afternoon on 25 Nov 2026/i)
    expect(d.basis).not.toContain('24 Nov')
  })
})
