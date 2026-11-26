import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDecision } from '../src/choices'
import { currentDuring, forecastSummary, outlookPoints, stale, type Bulletin, type Profile } from '../src/domain'
import { decisionContext, evidenceRevision, resolveExplanation } from '../src/explanationFacts'
import { explanationSchema } from '../src/contracts'
import { route } from '../worker/index'
import { playtimeRevisions } from './fixtures/playtimeRevisions'

const hour = 3_600_000
const ist = (time: string, day = '2026-11-24') => Date.parse(day + 'T' + time + '+05:30')
const family: Profile = { people: 'With children', travel: 'Work from home', activity: 'Playtime', period: 'Afternoon' }
const first = ist('12:30')
const moderate = [80, 75, 70, 65, 60]
const samples = (start: number, values: number[]) =>
  values.map((aqi, i) => ({ time: start + i * hour, aqi }))
function bulletin(start = first, values = moderate): Bulletin {
  return {
    city: 'delhi', aqi: 352, valid: start - hour, retrieved: start - 60_000,
    pm25: null, pm10: null, hours: samples(start, values),
  }
}

const uncertainAction = /recheck|check.*(?:air|condition)|indoors|wait|postpone/i
const currentHazardClaim = /current (?:modeled )?(?:US )?AQI is 352|currently hazardous|hazardous now/i
const currentUncertain = /current[^.]*?(?:unavailable|unknown|need|missing|confirm)|no (?:fresh |current )?(?:reading|estimate)/i

describe('an active outing as its current estimate ages out', () => {
  it.each([
    ['Morning', '06:30', '05:30', [80, 75, 70, 65, 60, 55]],
    ['Afternoon', '12:30', '11:30', moderate],
    ['Evening', '17:30', '16:30', moderate],
  ] as const)('keeps %s advice conservative across the exact one-hour cutoff', (period, clock, latest, values) => {
    const cutoff = ist(clock)
    const data = bulletin(cutoff, [...values])
    const profile = { ...family, period }
    const before = makeDecision(data, profile, cutoff - 1_000)
    expect(before.outing.reason).toMatch(/current.*352.*hazardous/i)
    expect(before.recommended.title).toMatch(/playtime indoors/i)

    for (const at of [cutoff, cutoff + 1_000]) {
      const decision = makeDecision(data, profile, at)
      expect(currentDuring(data, decision.outing, at)).toBeNull()
      expect(decision.outing.title).toMatch(uncertainAction)
      expect(decision.outing.title).not.toMatch(/breaks into playtime/i)
      expect(decision.basis).toMatch(currentUncertain)
      expect(decision.basis).not.toMatch(currentHazardClaim)
      expect(decision.basis).toContain('352')
      expect(decision.basis).toContain(latest)
      expect(decision.recommended.id).not.toBe('selected-outing')
      expect(decision.alternative).toBeNull()
      expect(outlookPoints(data, at, cutoff + 6 * hour)).toEqual(data.hours)
    }
  })

  it('withholds an outdoor-now choice for missing AQI even at an exact moderate forecast timestamp', () => {
    const data = { ...bulletin(), valid: first, aqi: null }
    const decision = makeDecision(data, family, first)
    expect(decision.outing.title).toMatch(uncertainAction)
    expect(decision.alternative).toBeNull()
    expect(decision.basis).not.toMatch(/current (?:modeled )?US AQI is 80/i)
    expect(outlookPoints(data, first, ist('17:00'))).toEqual(data.hours)
  })

  it('keeps the distinction between the unknown present and the two regional forecast periods', () => {
    const data = bulletin()
    data.hours.push(...samples(ist('17:30'), [305, 310, 315, 320, 325]))
    const at = first + 1_000
    const outlook = forecastSummary(data, at, ist('22:00'))
    expect(outlook).toMatch(currentUncertain)
    expect(outlook).toMatch(/evening[^.]*hazardous/i)
    expect(outlook).not.toMatch(currentHazardClaim)
    expect(outlookPoints(data, at, ist('22:00'))).toEqual(data.hours)
  })

  it('keeps a not-yet-valid estimate out of current and historical claims until its own timestamp', () => {
    const valid = ist('12:45')
    const data = { ...bulletin(), valid, retrieved: ist('12:35') }
    const before = makeDecision(data, family, valid - 1)
    expect(currentDuring(data, before.outing, valid - 1)).toBeNull()
    expect(before.outing.title).toMatch(uncertainAction)
    expect(before.basis).not.toMatch(currentHazardClaim)
    expect(before.basis).not.toMatch(/earlier[^.]*352|historical[^.]*352/i)
    const eligible = makeDecision(data, family, valid)
    expect(currentDuring(data, eligible.outing, valid)).toBe(352)
    expect(eligible.outing.reason).toMatch(/current.*352.*hazardous/i)
  })

  it('supports a genuinely current moderate estimate only with enough forecast coverage', () => {
    const at = first + 1_000
    const data = { ...bulletin(), aqi: 72, valid: first }
    expect(makeDecision(data, family, at).outing.title).toMatch(/breaks into playtime/i)
    const incomplete = { ...data, hours: data.hours.filter((p) => p.time !== ist('14:30')) }
    expect(makeDecision(incomplete, family, at).outing.title).toMatch(uncertainAction)
    const adverse = { ...incomplete, hours: [...incomplete.hours.slice(0, 2), { time: ist('16:30'), aqi: 360 }] }
    expect(makeDecision(adverse, family, at).outing.title).toMatch(/indoors/i)
  })

  it('keeps the three-hour bulletin boundary distinct from current AQI eligibility', () => {
    const cutoff = ist('14:30')
    const data = { ...bulletin(), retrieved: ist('14:25') }
    for (const at of [cutoff - 1, cutoff, cutoff + 1]) {
      const decision = makeDecision(data, family, at)
      expect(currentDuring(data, decision.outing, at)).toBeNull()
      expect(decision.outing.title).toMatch(uncertainAction)
      expect(decision.outing.reason).not.toMatch(currentHazardClaim)
      expect(stale(data, at)).toBe(at > cutoff)
      const displayed = outlookPoints(data, at, ist('17:00'))
      if (at > cutoff) expect(displayed).toEqual([])
      else expect(displayed).toContainEqual({ time: ist('16:30'), aqi: 60 })
    }
  })

  it('can plan a later moderate morning across midnight using its own dated forecasts', () => {
    const tomorrow = '2026-11-25'
    const midnight = ist('00:00', tomorrow)
    const morning = ist('06:30', tomorrow)
    const data = { ...bulletin(), valid: ist('23:00'), retrieved: ist('23:59'),
      hours: samples(morning, [80, 75, 70, 65, 60, 55]) }
    for (const at of [midnight - 1, midnight, midnight + 1]) {
      const decision = makeDecision(data, { ...family, period: 'Morning' }, at)
      expect(decision.outing.start).toBe(ist('06:00', tomorrow))
      expect(decision.outing.title).toMatch(/breaks into playtime/i)
      expect(decision.basis).toMatch(/25 Nov 2026.*forecast.*55–80/i)
      expect(decision.basis).not.toMatch(currentHazardClaim)
    }
  })
})

afterEach(() => vi.useRealTimers())

function snapshot(data: Bulletin, now: number, profile = family) {
  const decision = makeDecision(data, profile, now)
  return { decision, context: decisionContext(data, profile, decision, now) }
}
async function post(data: Bulletin, context: string, profile = family) {
  return new Request('https://local.test/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city: data.city, profile, valid: data.valid,
      retrieved: data.retrieved, revision: await evidenceRevision(context) }),
  })
}

describe('Worker explanations at the current-estimate boundary', () => {
  it.each([
    [first - 1_000, playtimeRevisions.current, 'Move playtime indoors'],
    [first, playtimeRevisions.earlier, 'Recheck conditions before playtime'],
  ] as const)('accepts the Phase A browser revision at %s', async (at, revision, title) => {
    vi.useFakeTimers()
    vi.setSystemTime(at)
    const data = bulletin()
    const request = new Request('https://local.test/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'delhi', profile: family, valid: data.valid, retrieved: data.retrieved, revision }),
    })
    const response = await route(request, {}, async () => ({ data }))
    expect(response.status).toBe(200)
    const answer = explanationSchema.parse(await response.json())
    expect(await evidenceRevision(answer.context)).toBe(revision)
    const [, , decision] = JSON.parse(answer.context)
    expect(decision.outing).toMatchObject({ period: 'Afternoon', kind: 'outing', title })
  })

  function finishAt(time: number) {
    return vi.fn(async () => {
      vi.setSystemTime(time)
      return { choices: [{ message: { content: JSON.stringify({
        prefer: { option: 'selected-outing', goals: ['keeps-outdoor-activity'] },
        switchIf: { option: 'indoor', goal: 'smoke-free-play' },
        cost: 'depends-on-local-conditions', limit: { option: 'indoor', fact: 'no-indoor-reading' },
      }) } }] }
    })
  }

  it('rejects the earlier revision and resolves the new one without an outdoor option or inference', async () => {
    vi.useFakeTimers()
    const data = bulletin()
    const before = snapshot(data, first - 1_000)
    const after = snapshot(data, first + 1_000)
    vi.setSystemTime(first + 1_000)
    const load = async () => ({ data })
    const limit = vi.fn(async () => ({ success: true }))
    const run = vi.fn()
    const env = { AI: { run }, EXPLANATIONS: { limit } }
    expect((await route(await post(data, before.context), env, load)).status).toBe(409)
    const response = await route(await post(data, after.context), env, load)
    expect(response.status).toBe(200)
    const answer = explanationSchema.parse(await response.json())
    expect(answer.mode).toBe('rules')
    const view = resolveExplanation(answer, after.decision, after.context)
    expect(view.recommended.title).toMatch(uncertainAction)
    expect(view.alternative).toBeNull()
    expect(limit).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('discards a comparison when the current estimate ages out while the model is preparing it', async () => {
    vi.useFakeTimers()
    // Keep the hourly grid unchanged during the request; only the current model's age changes.
    const cutoff = ist('12:47')
    const data = { ...bulletin(), aqi: 72, valid: ist('11:47'), retrieved: ist('12:46') }
    vi.setSystemTime(cutoff - 1)
    const display = snapshot(data, cutoff - 1)
    const run = finishAt(cutoff)
    const result = await route(await post(data, display.context),
      { AI: { run }, EXPLANATIONS: { limit: async () => ({ success: true }) } }, async () => ({ data }))
    expect(run).toHaveBeenCalledOnce()
    expect(result.status).toBe(409)
    expect(makeDecision(data, family, cutoff).recommended.title).toMatch(uncertainAction)
  })

  it('changes the explanation revision for a future outing when only current-reading eligibility changes', async () => {
    vi.useFakeTimers()
    const evening = { ...family, period: 'Evening' as const }
    const cutoff = ist('12:47')
    const data = { ...bulletin(), aqi: 72, valid: ist('11:47'), retrieved: ist('12:46'),
      hours: samples(ist('17:30'), moderate) }
    const before = snapshot(data, cutoff - 1, evening)
    const after = snapshot(data, cutoff, evening)
    expect(before.decision.outing.title).toMatch(/breaks into playtime/i)
    expect(after.decision.outing.title).toBe(before.decision.outing.title)
    expect(after.context).not.toBe(before.context)

    vi.setSystemTime(cutoff - 1)
    const run = finishAt(cutoff)
    const env = { AI: { run }, EXPLANATIONS: { limit: vi.fn(async () => ({ success: true })) } }
    const load = async () => ({ data })
    const delayed = await route(await post(data, before.context, evening), env, load)
    expect(delayed.status).toBe(409)
    const replay = await route(await post(data, before.context, evening), env, load)
    expect(replay.status).toBe(409)
    const response = await route(await post(data, after.context, evening), env, load)
    expect(response.status).toBe(200)
    const rules = explanationSchema.parse(await response.json())
    expect(rules.mode).toBe('rules')
    expect(resolveExplanation(rules, after.decision, after.context).recommended.title)
      .toMatch(/breaks into playtime/i)
    expect(env.EXPLANATIONS.limit).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })
})
