import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaults, hour, type Bulletin, type Profile } from '../src/domain'
import { makeDecision } from '../src/choices'
import { decisionContext, evidenceRevision, resolveExplanation } from '../src/explanationFacts'
import { explanationProtocol, explanationSchema, ruleDetails, type Reasoning } from '../src/contracts'
import { semanticContext } from '../src/explanationEvidence'
import { model, type InferenceBindings } from '../worker/ai'
import worker, { getAir, route } from '../worker/index'

const now = Date.parse('2026-11-23T07:30:00+05:30')
const day = Date.parse('2026-11-23T06:30:00+05:30')
const b: Bulletin = {
  city: 'delhi', valid: now, retrieved: now, aqi: 55, pm25: 37, pm10: 50,
  hours: Array.from({ length: 16 }, (_, i) => ({ time: day + i * hour, aqi: 55 })),
}
const play: Profile = { people: 'With children', travel: 'Work from home', period: 'Afternoon', activity: 'Playtime' }
const errands: Profile = { people: 'With older adults', travel: 'Car or two-wheeler', period: 'Evening', activity: 'Errands' }
const hazard = {
  ...b,
  hours: b.hours.map((h, i) => i >= 6 && i < 11 ? { ...h, aqi: [352, 353, 355, 354, 352][i - 6] } : h),
}
const indoorLater: Reasoning = {
  prefer: { option: 'indoor', goals: ['keeps-period', 'smoke-free-play'] },
  switchIf: { option: 'later-period', goal: 'keeps-outdoor-activity' },
  cost: 'changes-setting', limit: { option: 'later-period', fact: 'recheck-later' },
}
const briefErrands: Reasoning = {
  prefer: { option: 'short-list', goals: ['short-list'] },
  switchIf: { option: 'combine-stops', goal: 'avoids-extra-trip' },
  cost: 'leaves-errands-outstanding', limit: { option: 'combine-stops', fact: 'no-route-estimate' },
}

const post = (value: unknown, headers: Record<string, string> = {}) =>
  new Request('https://local.test/api/explain', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value),
  })
const input = { city: 'delhi', profile: defaults, valid: now }
async function snapshot(air: Bulletin, profile: Profile, at: number) {
  const context = decisionContext(air, profile, makeDecision(air, profile, at), at)
  return {
    city: air.city, valid: air.valid, retrieved: air.retrieved, profile,
    revision: await evidenceRevision(context),
  }
}
const get = vi.fn(async () => ({ data: b }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  get.mockClear()
})

function binding(reply: unknown, allowed = true) {
  const run = vi.fn<NonNullable<InferenceBindings['AI']>['run']>(async () => ({
    choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
  }))
  return { AI: { run }, EXPLANATIONS: { limit: vi.fn(async () => ({ success: allowed })) } }
}

async function explain(env: InferenceBindings, air: Bulletin | null, profile: Profile) {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const response = await route(post({ city: 'delhi', valid: air?.valid ?? null, profile }), env,
    async () => ({ data: air }))
  expect(response.status).toBe(200)
  return explanationSchema.parse(await response.json())
}

function view(answer: Awaited<ReturnType<typeof explain>>, air: Bulletin, p: Profile) {
  const d = makeDecision(air, p, now)
  return resolveExplanation(explanationSchema.parse(answer), d, decisionContext(air, p, d, now))
}

describe('grounded household comparisons via the Worker', () => {
  it('sends server-resolved dated evidence and keeps a hazardous outing indoors in both response modes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const env = binding(indoorLater)
    const ai = await explain(env, hazard, play)
    expect(ai.mode).toBe('model')
    expect(env.AI.run).toHaveBeenCalledOnce()
    expect(env.AI.run).toHaveBeenCalledWith(model, expect.objectContaining({
      max_completion_tokens: 350, response_format: { type: 'json_object' },
      messages: expect.arrayContaining([expect.objectContaining({
        role: 'user', content: expect.stringContaining('352–355 US AQI (Hazardous'),
      })]),
    }), expect.objectContaining({ signal: expect.anything() }))
    const [, prompt] = env.AI.run.mock.calls[0]
    if (!('messages' in prompt)) throw Error('Expected chat input')
    const packet = JSON.parse(String(prompt.messages.find((m) => m.role === 'user')?.content))
    expect(packet).toMatchObject({
      city: 'Delhi', source: 'Open-Meteo / CAMS global modeled estimate',
      valid: new Date(now).toISOString(), retrieved: new Date(now).toISOString(),
      US_AQI: 55, PM25_ug_m3: 37, PM10_ug_m3: 50, profile: play,
    })
    const res = await route(post({ city: 'delhi', valid: now, profile: play }), {}, async () => ({ data: hazard }))
    expect(res.status).toBe(200)
    const rules = explanationSchema.parse(await res.json())
    expect(rules.mode).toBe('rules')
    for (const answer of [ai, rules]) {
      const result = view(answer, hazard, play)
      expect(result.recommended.title).toMatch(/move playtime indoors/i)
      expect(result.alternative?.title).toMatch(/evening on 23 Nov 2026/i)
      expect(answer.context).toContain('Afternoon · 23 Nov 2026')
      expect(answer.context).toContain('352–355 US AQI (Hazardous')
      expect(result.recommended.title).not.toMatch(/build breaks|safer at|best hour/i)
    }
    const comparison = view(ai, hazard, play)
    expect(comparison.reason).toMatch(/chosen period.*play space/i)
    expect(comparison.switchWhen).toMatch(/outdoors matters more/)
    expect(comparison.limitation).toMatch(/check the forecast again/i)
  })

  it('uses the same bulletin to weigh a short older-adult errand list against consolidating vehicle stops', async () => {
    const answer = await explain(binding(briefErrands), hazard, errands)
    expect(answer.mode).toBe('model')
    const result = view(answer, hazard, errands)
    expect(result.recommended.title).toMatch(/errand list short/i)
    expect(result.switchWhen).toMatch(/separate vehicle trip.*matters more/i)
    expect(result.limitation).toMatch(/no route or travel-time estimate/i)
    expect(answer.context).toContain('Evening · 23 Nov 2026')
    expect(answer.context).not.toContain('Hazardous')
  })

  it('can reach two different justified decisions for the exact same moderate playtime forecast', async () => {
    const outside: Reasoning = {
      prefer: { option: 'selected-outing', goals: ['keeps-outdoor-activity'] },
      switchIf: { option: 'indoor', goal: 'at-home' },
      cost: 'depends-on-local-conditions', limit: { option: 'selected-outing', fact: 'regional-forecast' },
    }
    const inside: Reasoning = {
      prefer: { option: 'indoor', goals: ['at-home', 'smoke-free-play'] },
      switchIf: { option: 'selected-outing', goal: 'keeps-outdoor-activity' },
      cost: 'changes-setting', limit: { option: 'indoor', fact: 'no-indoor-reading' },
    }
    const preferred = await explain(binding(outside), b, play)
    const alternate = await explain(binding(inside), b, play)
    expect([preferred.mode, alternate.mode]).toEqual(['model', 'model'])
    expect(preferred.context).toBe(alternate.context)
    const first = view(preferred, b, play)
    expect(first.recommended.title).toMatch(/breaks into playtime/i)
    expect(first.reason).toMatch(/keeping playtime outdoors/i)
    expect(first.switchWhen).toMatch(/work-from-home/i)
    const second = view(alternate, b, play)
    expect(second.recommended.title).toMatch(/playtime indoors/i)
    expect(second.reason).toMatch(/work-from-home.*incense and candles/i)
    expect(second.switchWhen).toMatch(/keeping playtime outdoors/i)
    expect(second.limitation).toMatch(/no indoor air measurement/i)
  })

  it('drops a previous rationale when only the travel preference changes', async () => {
    const preference: Reasoning = {
      prefer: { option: 'indoor', goals: ['at-home'] },
      switchIf: { option: 'selected-outing', goal: 'keeps-outdoor-activity' },
      cost: 'changes-setting', limit: { option: 'indoor', fact: 'no-indoor-reading' },
    }
    const atHome = await explain(binding(preference), b, play)
    expect(atHome.mode).toBe('model')
    expect(view(atHome, b, play).reason).toMatch(/work-from-home/)
    const commuter: Profile = { ...play, travel: 'Public transport' }
    const trip = await explain(binding(preference), b, commuter)
    expect(trip).toMatchObject({ mode: 'rules', detail: ruleDetails.unverified })
    expect(view(trip, b, commuter).reason).not.toMatch(/work-from-home/)
  })

  it.each([
    ['non-JSON', 'abridged'],
    ['legacy response lacking the protective recommendation', { paragraphs: ['Afternoon play.', '55 US AQI.'] }],
    ['attempt to reverse a required protective decision', { ...indoorLater, prefer: { option: 'later-period', goals: ['keeps-outdoor-activity'] }, switchIf: { option: 'indoor', goal: 'smoke-free-play' }, cost: 'changes-period' }],
    ['current reading used to justify the excluded afternoon outing', { ...indoorLater, prefer: { option: 'selected-outing', goals: ['play-breaks'] } }],
    ['unsupported numerical, medical or impact claims', { ...indoorLater, why: 'This eliminates symptoms and cuts exposure by 80%.' }],
    ['forged measurement in an evidence field', { ...indoorLater, limit: { option: 'indoor', fact: '55 US AQI indoors' } }],
    ['inapplicable evidence from a different activity', { ...indoorLater, cost: 'adds-stops' }],
    ['evidence attached to the wrong option', { ...indoorLater, limit: { option: 'indoor', fact: 'recheck-later' } }],
    ['same goal twice', { ...indoorLater, prefer: { option: 'indoor', goals: ['smoke-free-play', 'smoke-free-play'] } }],
    ['same option on both sides', { ...indoorLater, switchIf: { option: 'indoor', goal: 'at-home' } }],
    ['oversize output', 'x'.repeat(2001)],
  ])('retains the protective rule fallback on %s', async (_case, bad) => {
    const answer = await explain(binding(bad), hazard, play)
    expect(answer).toMatchObject({ mode: 'rules', reasoning: null, detail: ruleDetails.unverified })
    expect(view(answer, hazard, play).recommended.title).toMatch(/move playtime indoors/i)
  })

  it('skips inference on stale, incomplete and missing sources, preserving sampled adverse evidence', async () => {
    const env = binding(indoorLater)
    const partial = { ...hazard, hours: [hazard.hours[7]] }
    const answer = await explain(env, partial, play)
    const single = view(answer, partial, play)
    expect(answer).toMatchObject({ mode: 'rules', detail: ruleDetails.single })
    expect(single.recommended.title).toMatch(/move playtime indoors/i)
    expect(single.alternative).toBeNull()
    expect(single.limitation).toMatch(/complete forecast/)
    for (const air of [null, { ...b, notice: 'cached' as const }, { ...b, aqi: null }]) {
      expect((await explain(env, air, play)).detail).toBe(ruleDetails.current)
    }
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('handles unavailable bindings, rate limits, quota errors and missing completions', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await explain({}, b, errands)).detail).toBe(ruleDetails.binding)
    const denied = binding(briefErrands, false)
    expect((await explain(denied, b, errands)).detail).toBe(ruleDetails.limit)
    expect(denied.AI.run).not.toHaveBeenCalled()
    const env = binding(briefErrands)
    env.AI.run.mockRejectedValueOnce(Error('quota exceeded')).mockResolvedValueOnce({ choices: [] })
    for (let i = 0; i < 2; i++) {
      const result = await explain(env, b, errands)
      expect(result).toMatchObject({ mode: 'rules', detail: ruleDetails.unverified })
      expect(view(result, b, errands).recommended.title).toMatch(/errand list short/i)
    }
    expect(env.AI.run).toHaveBeenCalledTimes(2)
    expect(failure).not.toHaveBeenCalled()
  })

  it('retains a rules fallback and reports an internal fault during model response validation', async () => {
    const env = binding(briefErrands)
    env.AI.run.mockResolvedValueOnce({
      get choices() { throw Error('private runtime detail') },
    })
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await explain(env, b, errands)
    expect(result).toMatchObject({ mode: 'rules', reasoning: null, detail: ruleDetails.unverified })
    expect(JSON.stringify(result)).not.toContain('private runtime detail')
    expect(failure.mock.calls).toEqual([[{ event: 'internal_failure', operation: 'model_explanation' }]])
  })

  it('aborts a stalled model call at its deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort())
    try {
      const env = binding(briefErrands)
      env.AI.run.mockImplementation(async (_model, _input, options) => {
        options.signal?.throwIfAborted()
        throw Error('Expected the signal to abort')
      })
      expect((await explain(env, b, errands)).detail).toBe(ruleDetails.unverified)
      expect(timeout).toHaveBeenCalledWith(12000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('preserves a verified rationale across an identical retrieval and rejects changed source facts or household', async () => {
    const answer = await explain(binding(indoorLater), hazard, play)
    expect(view(answer, { ...hazard, retrieved: now + 1 }, play)).toEqual(view(answer, hazard, play))
    for (const revised of [
      { ...hazard, city: 'noida' as const }, { ...hazard, valid: now - 1 },
      { ...hazard, pm25: 38 }, { ...hazard, aqi: 54 }, b,
    ]) {
      expect(() => view(answer, revised, play)).toThrow(/changed/)
    }
    expect(() => view(answer, hazard, errands)).toThrow(/changed/)
    expect(explanationSchema.safeParse({ ...answer, detail: 'Air is safe.' }).success).toBe(false)
  })
})
describe('Worker HTTP boundary', () => {
  it.each([
    [post({}), 400, 'input'],
    [post({ ...input, profile: { ...defaults, period: 'Overnight' } }), 400, 'input'],
    [post({ ...input, city: 'unknown' }), 400, 'input'],
    [post({ ...input, aqi: 4 }), 400, 'input'],
    [post({ ...input, revision: 'unknown' }), 400, 'input'],
    [post({ ...input, profile: { ...defaults, notes: 'free text' } }), 400, 'input'],
    [post(input, { Origin: 'https://other.example' }), 403, 'origin'],
    [post(input, { 'Content-Type': 'text/plain' }), 415, 'format'],
    [post(input, { 'Content-Length': '2049' }), 413, 'input'],
    [post('x'.repeat(2050)), 413, 'input'],
    [new Request('https://local.test/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    }), 400, 'input'],
    [new Request('https://local.test/api/air?city=other'), 400, 'city'],
    [new Request('https://local.test/api/air', { method: 'POST' }), 405, 'method'],
    [new Request('https://local.test/api/explain'), 405, 'method'],
    [new Request('https://local.test/api/unknown'), 404, 'not-found'],
  ] as const)(
    'rejects invalid requests before accessing data or consuming quota',
    async (req, status, error) => {
      const env = binding(briefErrands)
      const response = await route(req, env, get)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error })
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(get).not.toHaveBeenCalled()
      expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
      expect(env.AI.run).not.toHaveBeenCalled()
    },
  )
  it('serves a successful air bulletin with the public JSON headers', async () => {
    const response = await route(new Request('https://local.test/api/air?city=delhi'), {}, get)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toEqual(b)
    expect(get).toHaveBeenCalledWith('delhi')
  })
  it('accepts 2048 JSON bytes and rejects 2049 without consulting the source', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const payload = JSON.stringify({ ...input, valid: null })
    const request = (length: number) => new Request('https://local.test/api/explain', {
      method: 'POST', headers: { Origin: 'https://local.test', 'Content-Type': 'application/json; charset=utf-8' },
      body: payload.padEnd(length, ' '),
    })
    expect((await route(request(2048), {}, get)).status).toBe(200)
    expect((await route(request(2049), {}, get)).status).toBe(413)
    expect(get).not.toHaveBeenCalled()
  })
  it.each([
    ['read', new RangeError(), 413],
    ['read', new Error(), 400],
    ['cancel', new RangeError(), 413],
    ['cancel', new Error(), 400],
  ] as const)('preserves the HTTP status for a rejected stream %s', async (operation, error, status) => {
    const options = {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          if (operation === 'read') controller.error(error)
          else controller.enqueue(new Uint8Array(2049))
        },
        cancel() { throw error },
      }),
    }
    const request = new Request('https://local.test/api/explain', options)
    const response = await route(request, {}, get)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: 'input' })
    expect(get).not.toHaveBeenCalled()
  })
  it('keeps quota denial and a failing limiter labeled, before model inference', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const env = binding(briefErrands, false)
    const payload = await snapshot(b, errands, now)
    const request = () => post(payload, { 'CF-Connecting-IP': '192.0.2.1' })
    env.EXPLANATIONS.limit.mockResolvedValueOnce({ success: false }).mockRejectedValueOnce(Error('binding unavailable'))
    for (const detail of ['Explanation limit reached. Try again in a minute.', 'The AI service could not return a verified comparison.']) {
      const response = await route(request(), env, get)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ mode: 'rules', reasoning: null, detail })
    }
    expect(env.EXPLANATIONS.limit).toHaveBeenCalledWith({ key: '192.0.2.1' })
    expect(env.AI.run).not.toHaveBeenCalled()
  })
  it('rejects changed source time and explains a no-data request locally', async () => {
    expect(
      (await route(post({ ...input, valid: now + 1 }), {}, get)).status,
    ).toBe(409)
    const res = await route(post({ ...input, valid: null }), {}, get)
    expect(await res.json()).toMatchObject({ mode: 'rules' })
    expect(get).toHaveBeenCalledTimes(1)
  })
  it('rejects a refreshed source or a different city before asking the model', async () => {
    const run = vi.fn()
    const limit = vi.fn(async () => ({ success: true }))
    const env = { AI: { run }, EXPLANATIONS: { limit } }
    for (const source of [{ ...b, retrieved: b.retrieved + 1 }, { ...b, city: 'mumbai' as const }]) {
      const response = await route(post({ ...input, retrieved: b.retrieved }), env,
        async () => ({ data: source }))
      expect(response.status).toBe(409)
    }
    expect(limit).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('keeps the response verifiable by a tab using the earlier request format with matching source timestamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const response = await route(post({
      city: 'delhi', valid: b.valid, retrieved: b.retrieved, profile: errands,
    }), binding(briefErrands), get)
    const legacyContext = JSON.stringify([
      [b.city, b.valid, b.retrieved, b.aqi, b.pm25, b.pm10, null],
      [errands.people, errands.travel, errands.period, errands.activity],
      makeDecision(b, errands, now),
    ])
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'model', context: legacyContext })
  })
  it('checks changed forecast and household revisions before the rate limiter or inference', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const env = binding(indoorLater)
    const request = await snapshot(hazard, play, now)
    for (const source of [b, { ...hazard, valid: now - 1 }, { ...hazard, notice: 'source' as const }, null]) {
      expect((await route(post(request), env, async () => ({ data: source }))).status).toBe(409)
    }
    expect((await route(post({ ...request, profile: errands }), env, async () => ({ data: hazard }))).status).toBe(409)
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()

    vi.setSystemTime(now + 60_000)
    const confirmed = { ...hazard, retrieved: Date.now() }
    const response = await route(post(request), env, async () => ({ data: confirmed }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'model' })
    expect(env.AI.run).toHaveBeenCalledOnce()
  })
  it.each(['valid', 'retrieved'] as const)('rejects a displayed snapshot whose %s time expired', async (field) => {
    vi.useFakeTimers()
    const maxAge = field === 'valid' ? 3 * hour : hour
    const source = { ...hazard, [field]: now - maxAge }
    const request = await snapshot(source, play, now)
    vi.setSystemTime(now + 1)
    const env = binding(indoorLater)
    const response = await route(post(request), env, async () => ({
      data: { ...source, retrieved: Date.now() },
    }))
    expect(response.status).toBe(409)
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()
  })
  it('checks the city-period boundary before inference and again before sending a pending result', async () => {
    vi.useFakeTimers()
    const noon = Date.parse('2026-11-23T12:00:00+05:30')
    const air = { ...b, aqi: 355, valid: noon - 1, retrieved: noon - 1 }
    const load = async () => ({ data: air })
    const request = await snapshot(air, play, noon - 1)
    const env = binding({
      prefer: { option: 'selected-outing', goals: ['keeps-outdoor-activity'] },
      switchIf: { option: 'indoor', goal: 'at-home' },
      cost: 'depends-on-local-conditions', limit: { option: 'indoor', fact: 'no-indoor-reading' },
    })
    vi.setSystemTime(noon)
    expect((await route(post(request), env, load)).status).toBe(409)
    expect(env.AI.run).not.toHaveBeenCalled()

    vi.setSystemTime(noon - 1)
    const completion = env.AI.run.getMockImplementation()!
    env.AI.run.mockImplementationOnce((...args) => {
      vi.setSystemTime(noon)
      return completion(...args)
    })
    expect((await route(post(request), env, load)).status).toBe(409)
    expect(env.AI.run).toHaveBeenCalledOnce()
  })
  it('withholds inference when valid evidence expires while awaiting the rate limiter', async () => {
    vi.useFakeTimers({ now })
    const env = binding(briefErrands)
    const data = { ...b, retrieved: now - hour }
    const decision = makeDecision(data, errands, now)
    const revision = await evidenceRevision(semanticContext(data.city, data, errands, decision, now))
    env.EXPLANATIONS.limit.mockImplementationOnce(async () => {
      vi.setSystemTime(now + 1)
      return { success: true }
    })
    const response = await route(post({
      protocol: explanationProtocol, city: data.city, profile: errands,
      valid: data.valid, retrieved: data.retrieved, revision,
    }), env, async () => ({ data }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'changed' })
    expect(env.EXPLANATIONS.limit).toHaveBeenCalledOnce()
    expect(env.AI.run).not.toHaveBeenCalled()
  })
  it('rejects an expired browser retrieval before and after inference despite a fresh Worker copy', async () => {
    vi.useFakeTimers()
    const env = binding(briefErrands)
    const request = { ...await snapshot(b, errands, now), retrieved: now - hour }
    vi.setSystemTime(now + 1)
    const expired = await route(post(request), env, get)
    expect(expired.status).toBe(409)
    expect(await expired.json()).toEqual({ error: 'changed' })
    expect(env.EXPLANATIONS.limit).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()

    vi.setSystemTime(now)
    env.AI.run.mockImplementationOnce(async () => {
      vi.setSystemTime(now + 1)
      return { choices: [{ message: { content: JSON.stringify(briefErrands) } }] }
    })
    const late = await route(post(request), env, get)
    expect(late.status).toBe(409)
    expect(await late.json()).toEqual({ error: 'changed' })
    expect(env.EXPLANATIONS.limit).toHaveBeenCalledOnce()
    expect(env.AI.run).toHaveBeenCalledOnce()
  })
  it('exposes source outages and upstream rate limits', async () => {
    const req = new Request('https://local.test/api/air?city=delhi')
    expect(
      (await route(req, {}, async () => ({ data: null, error: 'rate' })))
        .status,
    ).toBe(429)
    expect(
      (await route(req, {}, async () => ({ data: null, error: 'source' })))
        .status,
    ).toBe(503)
  })
})
describe('Worker cache', () => {
  function memoryCache() {
    const map = new Map<string, Response>()
    return {
      match: async (key: RequestInfo) => map.get(String(key))?.clone(),
      put: async (key: RequestInfo, v: Response) => {
        map.set(String(key), v.clone())
      },
    }
  }
  it('uses the provider deadline and accepts exactly the allowed response bytes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const deadline = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = JSON.stringify({
      latitude: 28.7, longitude: 77.2, current: { time: now / 1000, us_aqi: 55 },
      current_units: { time: 'unixtime', us_aqi: 'USAQI' },
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(payload.padEnd(48000)))
      .mockResolvedValueOnce(new Response(payload.padEnd(48001)))
    vi.stubGlobal('fetch', fetcher)
    const load = () => getAir('delhi', memoryCache(), 'https://local.test')
    expect((await load()).data?.aqi).toBe(55)
    expect(await load()).toEqual({ data: null, error: 'source' })
    expect(deadline).toHaveBeenCalledWith(8500)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: deadline.mock.results[0].value })
  })
  it.each([
    ['provider rate limit', async () => new Response(null, { status: 429 }), 429, 'rate'],
    ['provider outage', async () => new Response(null, { status: 503 }), 503, 'source'],
    ['transport failure', async () => { throw new TypeError('private network detail') }, 503, 'source'],
    ['invalid upstream JSON', async () => new Response('{'), 503, 'source'],
    ['invalid upstream schema', async () => Response.json({}), 503, 'source'],
  ] as const)('classifies %s without disclosing upstream details', async (_case, fetcher, status, kind) => {
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('caches', { default: memoryCache() })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await worker.fetch(new Request('https://local.test/api/air?city=delhi'), {})
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: kind })
    expect(warning.mock.calls).toEqual([[{ event: 'provider_failure', kind }]])
    expect(failure).not.toHaveBeenCalled()
  })
  it('reports a local refresh fault separately and retains the usual cached fallback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const cache = memoryCache()
    const saved = { ...b, retrieved: now - hour }
    await cache.put('https://local.test/internal-cache/v1/delhi', Response.json(saved))
    vi.stubGlobal('caches', { default: cache })
    vi.stubGlobal('fetch', vi.fn(async () => {
      vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => { throw Error('private runtime detail') })
      return new Response('{}')
    }))
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await worker.fetch(new Request('https://local.test/api/air?city=delhi'), {})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...saved, notice: 'source' })
    expect(failure.mock.calls).toEqual([[{ event: 'internal_failure', operation: 'refresh_bulletin' }]])
    expect(warning).not.toHaveBeenCalled()
  })
  it('keeps an unexpected request fault private and preserves the public 503 contract', async () => {
    vi.stubGlobal('caches', { get default() { throw Error('private runtime detail') } })
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await worker.fetch(new Request('https://local.test/api/air?city=delhi'), {})
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'source' })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(failure.mock.calls).toEqual([[{ event: 'internal_failure', operation: 'handle_request' }]])
    expect(warning).not.toHaveBeenCalled()
  })
  it('reuses fresh data, preserves original timestamps on failure and backs off', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const cache = memoryCache(),
      origin = 'https://local.test'
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }))
    vi.stubGlobal('fetch', fetcher)
    await cache.put(origin + '/internal-cache/v1/delhi', Response.json(b))
    expect((await getAir('delhi', cache, origin)).data).toEqual(b)
    expect(fetcher).not.toHaveBeenCalled()
    vi.setSystemTime(now + hour)
    expect((await getAir('delhi', cache, origin)).data).toEqual({
      ...b,
      notice: 'rate',
    })
    expect((await getAir('delhi', cache, origin)).data?.retrieved).toBe(now)
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 25 * hour)
    expect((await getAir('delhi', cache, origin)).data).toBeNull()
  })
  it('replaces an unordered cached bulletin and serves the following explanation from one retrieval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const origin = 'https://local.test'
    const cache = memoryCache()
    const unordered = { ...b, hours: [b.hours[1], b.hours[0]] }
    await cache.put(origin + '/internal-cache/v1/delhi', Response.json(unordered))
    const provider = vi.fn(async () => Response.json({
      latitude: 28.7, longitude: 77.2,
      current: { time: now / 1000, us_aqi: b.aqi, pm2_5: b.pm25, pm10: b.pm10 },
      current_units: { time: 'unixtime', us_aqi: 'USAQI', pm2_5: 'μg/m³', pm10: 'μg/m³' },
      hourly: { time: b.hours.map((h) => h.time / 1000), us_aqi: b.hours.map((h) => h.aqi) },
      hourly_units: { time: 'unixtime', us_aqi: 'USAQI' },
    }))
    vi.stubGlobal('fetch', provider)
    const load = () => getAir('delhi', cache, origin)
    const air = await route(new Request(origin + '/api/air?city=delhi'), {}, load)
    expect(await air.json()).toEqual(b)
    const response = await route(post(await snapshot(b, errands, now)), binding(briefErrands), load)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'model' })
    expect(provider).toHaveBeenCalledOnce()
  })
  it('withholds a cached bulletin with duplicate timestamps when the provider fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const cache = memoryCache(), origin = 'https://local.test'
    const saved = { ...b, retrieved: now - hour, hours: [b.hours[0], b.hours[0]] }
    await cache.put(origin + '/internal-cache/v1/delhi', Response.json(saved))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    expect(await getAir('delhi', cache, origin)).toEqual({ data: null, error: 'source' })
  })
  it('withholds a saved estimate if it expires during a failed provider check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const cache = memoryCache(), origin = 'https://local.test'
    const saved = { ...b, valid: now - 24 * hour, retrieved: now - hour }
    await cache.put(origin + '/internal-cache/v1/delhi', Response.json(saved))
    vi.stubGlobal('fetch', vi.fn(async () => {
      vi.setSystemTime(now + 1)
      return new Response(null, { status: 503 })
    }))
    expect(await getAir('delhi', cache, origin)).toEqual({ data: null, error: 'source' })
  })
})
