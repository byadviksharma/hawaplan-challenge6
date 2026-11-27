import { z } from 'zod'
import type { AiModels, AiOptions, RateLimit } from '@cloudflare/workers-types'
import { cities, modeledReading, type Bulletin, type Profile } from '../src/domain'
import type { HouseholdDecision } from '../src/choices'
import { interpretReasoning, InvalidReasoningError } from '../src/explanationFacts'
import { reasoningSchema, type RuleDetailCode } from '../src/contracts'

export type InferenceBindings = {
  AI?: {
    run(
      name: typeof model,
      input: AiModels[typeof model]['inputs'],
      options: AiOptions,
    ): Promise<unknown>
  }
  EXPLANATIONS?: RateLimit
}
export const model = '@cf/google/gemma-4-26b-a4b-it'

const instructions = [
  'Help the household weigh the supplied feasible options. Work out which goals fit its profile, one real cost of your choice, and which competing priority would make the other option worth considering.',
  'Return only JSON with this shape: {"prefer":{"option":"option-id","goals":["fit-id"]},"switchIf":{"option":"other-option-id","goal":"other-fit-id"},"cost":"tradeoff-id","limit":{"option":"option-id","fact":"limit-id"}}.',
  'Prefer the planner recommendation unless the alternative has canLead:true and better fits a household priority. A warning or a conditional alternative must never be promoted over the required action.',
  'Bind one or two distinct fit goals to the preferred option. For switchIf, choose a genuinely different goal of the other option. Select a tradeoff of the preferred option and one relevant limit of either option.',
  'Use only IDs from this decision, with their specified roles and option owners. Keep readings, dates and prose out of the response.',
].join(' ')

const completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().max(2000) }) })).min(1),
})

function verifiedReasoning(result: unknown, decision: HouseholdDecision) {
  try {
    const text = completion.parse(result).choices[0].message.content
    const reasoning = reasoningSchema.parse(JSON.parse(text))
    interpretReasoning(decision, reasoning)
    return reasoning
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof InvalidReasoningError)
      return null
    throw error
  }
}

export async function inferExplanation(
  env: InferenceBindings,
  b: Bulletin | null,
  p: Profile,
  key: string,
  now: number,
  decision: HouseholdDecision,
  evidenceStillMatches: () => boolean,
) {
  const rules = (detail: RuleDetailCode) => ({
    mode: 'rules' as const, detail, created: Date.now(), reasoning: null,
  })
  const reading = modeledReading(b, now)
  if (!b || reading?.kind !== 'current') return rules('current')
  if (!decision.alternative) return rules('single')
  if (!env.AI || !env.EXPLANATIONS) return rules('binding')
  try {
    const quota = await env.EXPLANATIONS.limit({ key }).catch(() => null)
    if (!quota) return rules('unverified')
    if (!quota.success) return rules('limit')
    if (!evidenceStillMatches()) return null
    const result = await env.AI.run(
      model,
      {
        messages: [
          { role: 'system', content: instructions },
          {
            role: 'user',
            content: JSON.stringify({
              city: cities[b.city].name,
              source: 'Open-Meteo / CAMS global modeled estimate',
              valid: new Date(b.valid).toISOString(),
              retrieved: new Date(b.retrieved).toISOString(),
              US_AQI: reading.aqi,
              PM25_ug_m3: b.pm25,
              PM10_ug_m3: b.pm10,
              profile: p,
              decision,
            }),
          },
        ],
        max_completion_tokens: 350,
        temperature: 0.2,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_object' },
      },
      { signal: AbortSignal.timeout(12000) } satisfies AiOptions,
    ).catch(() => null)
    const reasoning = verifiedReasoning(result, decision)
    if (!reasoning) return rules('unverified')
    return { mode: 'model' as const, created: Date.now(), detail: 'model' as const, reasoning }
  } catch {
    console.error({ event: 'internal_failure', operation: 'model_explanation' })
    return rules('unverified')
  }
}
