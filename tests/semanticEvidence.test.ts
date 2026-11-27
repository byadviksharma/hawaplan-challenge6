import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDecision, type HouseholdDecision } from '../src/choices'
import { explanationSchema, type Reasoning } from '../src/contracts'
import { hour, type Bulletin, type Profile } from '../src/domain'
import { semanticContext } from '../src/explanationEvidence'
import { evidenceRevision, interpretReasoning } from '../src/explanationFacts'
import { route } from '../worker/index'

const now = Date.parse('2026-11-24T11:30:00+05:30')
const family: Profile = { people: 'With children', period: 'Afternoon', travel: 'Work from home', activity: 'Playtime' }
const air: Bulletin = {
  city: 'delhi', aqi: 55, pm25: 30, pm10: 45, valid: now, retrieved: now,
  hours: [351, 354, 353, 352, 355, 52, 54, 56, 53, 55]
    .map((aqi, i) => ({ time: now + (i + 1) * hour, aqi })),
}
const comparison: Reasoning = {
  prefer: { option: 'indoor', goals: ['at-home', 'keeps-period'] },
  switchIf: { option: 'later-period', goal: 'lower-period' },
  cost: 'changes-setting', limit: { option: 'indoor', fact: 'no-indoor-reading' },
}
function context(data = air, profile = family, d = makeDecision(data, profile, now)) {
  return semanticContext(data.city, data, profile, d, now)
}
async function snapshot(data = air) {
  return { city: data.city, profile: family, valid: data.valid, retrieved: data.retrieved,
    protocol: 2, revision: await evidenceRevision(context(data)) }
}
function bindings(reasoning: Reasoning = comparison) {
  return {
    AI: { run: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(reasoning) } }] })) },
    EXPLANATIONS: { limit: vi.fn(async () => ({ success: true })) },
  }
}
function request(input: unknown, env: ReturnType<typeof bindings>, source = air) {
  const post = new Request('https://local.test/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  return route(post, env, async () => ({ data: source }))
}
afterEach(() => { vi.useRealTimers() })

describe('versioned explanation evidence', () => {
  it('accepts the public browser revision for a dated later alternative', async () => {
    vi.useFakeTimers({ now })
    // Captured from the e402b908 browser planner for the air and family above.
    const revision = '8c23f6ee1235103462f1b4b728547fe6064191b4ea225fb4b3b8c38dbd3edbde'
    const response = await request({ city: air.city, profile: family, valid: now, retrieved: now, revision }, bindings())
    expect(response.status).toBe(200)
    const answer = explanationSchema.parse(await response.json())
    expect(answer.mode).toBe('model')
    expect(await evidenceRevision(answer.context)).toBe(revision)
  })

  it('matches the protocol 2, policy 1 digest for afternoon playtime followed by a lower evening', async () => {
    // SHA-256 of the independently assembled Delhi fixture, including both windows' hourly readings.
    expect(await evidenceRevision(context())).toBe('3aab166829ae836f662ca78da38a44514a329aeaa765ff0d181c7c72d7c3abd2')
  })

  it('allows different client wording for every display field while verifying the same model choices', async () => {
    vi.useFakeTimers({ now })
    const d = makeDecision(air, family, now)
    d.outing.title = 'Reworded outing'
    d.outing.reason = 'Reworded reason'
    d.basis = 'Reworded basis'
    d.recommended.title = 'Reworded recommendation'
    d.alternative!.title = 'Reworded alternative'
    for (const fact of d.evidence) fact.text = 'Reworded ' + fact.id

    const revision = await evidenceRevision(context(air, family, d))
    const env = bindings()
    const response = await request({ ...await snapshot(), revision }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocol: 2, revision, mode: 'model', detail: 'model', created: now, reasoning: comparison,
    })
    expect(env.AI.run).toHaveBeenCalledOnce()
    expect(interpretReasoning(d, comparison)).toMatchObject({
      recommended: { title: 'Reworded recommendation' }, alternative: { title: 'Reworded alternative' },
      limitation: 'Reworded no-indoor-reading',
    })
  })

  it('binds the dated outing, eligible choices, authority to lead and typed evidence references', () => {
    const original = context()
    const changes: ((d: HouseholdDecision) => void)[] = [
      d => { d.outing.start += hour },
      d => { d.outing.kind = 'preparation' },
      d => { d.outing.caution = false },
      d => { d.recommended.id = 'postpone' },
      d => { d.alternative = null },
      d => { d.alternative!.canLead = true },
      d => { d.laterWindow!.start += hour },
      d => { d.laterWindow!.end -= hour },
      d => { d.evidence[0].option = 'later-period' },
      d => { d.evidence[0].role = 'limit' },
      d => { d.evidence[0].id = 'indoor-activity' },
      d => { d.evidence.pop() },
    ]
    for (const change of changes) {
      const edited = makeDecision(air, family, now)
      change(edited)
      expect(context(air, family, edited)).not.toBe(original)
    }
    const noData = makeDecision(null, family, now)
    expect(semanticContext('delhi', null, family, noData, now))
      .not.toBe(semanticContext('mumbai', null, family, noData, now))
  })

  it('retains ambiguity and shared-goal checks while keeping display text out of the revision', () => {
    const d = makeDecision(air, family, now)
    const goal = d.evidence.find(f => f.id === 'lower-period')!
    goal.text = d.evidence.find(f => f.id === 'at-home')!.text
    expect(context(air, family, d)).toBe(context())
    expect(() => interpretReasoning(d, comparison)).toThrow(/priorities/)

    goal.id = 'at-home'
    goal.text = 'Different phrasing of the shared priority'
    expect(() => interpretReasoning(d, {
      ...comparison, switchIf: { option: 'later-period', goal: 'at-home' },
    })).toThrow(/priorities/)
  })

  it('rejects unknown protocol or changed policy without downgrading the request', async () => {
    vi.useFakeTimers({ now })
    const env = bindings()
    const input = await snapshot()
    const facts = JSON.parse(context())
    expect(facts).toMatchObject({ protocol: input.protocol, policy: 1 })
    const revision = await evidenceRevision(JSON.stringify({ ...facts, policy: facts.policy + 1 }))
    expect((await request({ ...input, revision }, env)).status).toBe(409)
    expect((await request({ ...input, protocol: 3 }, env)).status).toBe(400)
    expect((await request({ ...input, revision: undefined }, env)).status).toBe(400)
    expect((await request({ ...input, retrieved: undefined }, env)).status).toBe(400)
    expect((await request({ ...input, retrieved: null }, env)).status).toBe(400)
    expect((await request({ ...input, valid: null }, env)).status).toBe(400)
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('rejects corrected source facts, coverage and household before quota or model access', async () => {
    vi.useFakeTimers({ now })
    const input = await snapshot()
    const env = bindings()
    // Neither corrected interior sample changes the displayed ranges or eligible options.
    const adjust = (i: number) => air.hours.map((p, j) => j === i ? { ...p, aqi: p.aqi! + 0.1 } : p)
    const sources: Bulletin[] = [
      { ...air, aqi: 55.1 }, { ...air, pm25: null }, { ...air, pm10: 46 },
      { ...air, valid: now - 1 }, { ...air, notice: 'cached' },
      { ...air, hours: adjust(2) }, { ...air, hours: adjust(8) },
      { ...air, hours: air.hours.filter((_p, i) => i !== 3) },
      { ...air, hours: air.hours.filter((_p, i) => i !== 6) },
    ]
    for (const source of sources) {
      expect((await request(input, env, source)).status).toBe(409)
    }
    for (const profile of [
      { ...family, travel: 'Walk or cycle' }, { ...family, people: 'Adults' },
      { ...family, period: 'Evening' }, { ...family, activity: 'Outdoor exercise' },
    ]) expect((await request({ ...input, profile }, env)).status).toBe(409)
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('allows a fresh confirming retrieval and rejects a fabricated model choice', async () => {
    vi.useFakeTimers({ now: now + 1 })
    const env = bindings({ ...comparison, limit: { option: 'indoor', fact: 'fabricated' } })
    const input = await snapshot()
    const response = await request(input, env, { ...air, retrieved: now + 1 })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: 'rules', detail: 'unverified', reasoning: null, revision: input.revision, protocol: 2,
    })
    expect(env.AI.run).toHaveBeenCalledOnce()
  })

  it.each(['valid', 'retrieved'] as const)('rejects the exact %s freshness transition before and after inference', async field => {
    vi.useFakeTimers({ now })
    const source = { ...air, [field]: now - hour + (field === 'valid' ? 1 : 0) }
    const input = await snapshot(source)
    const current = { ...source, retrieved: now }
    const env = bindings()
    vi.setSystemTime(now + 1)
    expect((await request(input, env, current)).status).toBe(409)
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()

    vi.setSystemTime(now)
    const respond = env.AI.run.getMockImplementation()!
    env.AI.run.mockImplementationOnce(() => {
      vi.setSystemTime(now + 1)
      return respond()
    })
    expect((await request(input, env, current)).status).toBe(409)
    expect(env.AI.run).toHaveBeenCalledOnce()
  })
})
