import type { ChoiceEvidence, HouseholdDecision } from './choices'
import type { Explanation, Reasoning } from './contracts'
import { modeledReading, type Bulletin, type Profile } from './domain'

// Both callers remove stale evidence first. Retrieval time controls freshness,
// but a second successful retrieval can confirm exactly the same source facts.
// The decision includes the dated outing, forecast range, coverage and options.
export function decisionContext(
  b: Bulletin | null, p: Profile, d: HouseholdDecision, now: number, format: 'revision' | 'legacy' = 'revision',
) {
  const reading = modeledReading(b, now)
  const source = b && (format === 'legacy'
    ? [b.city, b.valid, b.retrieved, b.aqi, b.pm25, b.pm10, b.notice ?? null]
    : [b.city, b.valid, b.aqi, b.pm25, b.pm10, ...(reading && reading.kind !== 'current' ? [reading.kind] : [])])
  return JSON.stringify([
    source,
    [p.people, p.travel, p.period, p.activity],
    d,
  ])
}

// A fixed-size request keeps the Worker input bounded. The Worker still builds
// all facts itself and the browser verifies the full returned decision context.
export async function evidenceRevision(context: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(context))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fact(d: HouseholdDecision, role: ChoiceEvidence['role'], option: string, id: string) {
  const found = d.evidence.find((f) => f.option === option && f.role === role && f.id === id)
  if (!found) throw Error('Unsupported evidence reference')
  return found
}

export function interpretReasoning(d: HouseholdDecision, r: Reasoning) {
  if (!d.alternative) throw Error('No supported comparison')
  const reverse = r.prefer.option === d.alternative.id
  if (reverse && !d.alternative.canLead) throw Error('Planner recommendation is required')
  const recommended = reverse ? d.alternative : d.recommended
  const alternative = reverse ? d.recommended : d.alternative
  if (r.prefer.option !== recommended.id || r.switchIf.option !== alternative.id)
    throw Error('Unsupported option pairing')

  const goals = r.prefer.goals.map((id) => fact(d, 'fit', recommended.id, id).text)
  const competing = fact(d, 'fit', alternative.id, r.switchIf.goal).text
  // A shared benefit cannot explain choosing one option over the other.
  const sharedPriority = d.evidence.some((f) => f.role === 'fit' && (
    (f.option === alternative.id && (r.prefer.goals.includes(f.id) || goals.includes(f.text))) ||
    (f.option === recommended.id && (f.id === r.switchIf.goal || f.text === competing))
  ))
  if (new Set(goals).size !== goals.length || sharedPriority)
    throw Error('Comparison requires different priorities')
  const concession = fact(d, 'tradeoff', recommended.id, r.cost).text
  const limitation = fact(d, 'limit', r.limit.option, r.limit.fact).text
  const priority = goals.join(' and ')
  return {
    recommended,
    alternative,
    reason: 'This favors ' + priority + '. ' + concession,
    switchWhen: 'Consider this if ' + competing + ' matters more.',
    limitation,
  }
}

export function ruleReasoning(d: HouseholdDecision) {
  const first = (role: ChoiceEvidence['role'], option?: string) =>
    d.evidence.find((f) => f.role === role && (option === undefined || f.option === option))?.text
  const fit = first('fit', d.recommended.id)
  const otherFit = d.alternative && first('fit', d.alternative.id)
  return {
    recommended: d.recommended,
    alternative: d.alternative,
    reason: fit ? 'This favors ' + fit + '.' : '',
    switchWhen: otherFit ? 'Consider this if your priority is ' + otherFit + '.' : null,
    limitation: first('limit') ?? null,
  }
}

export function resolveExplanation(answer: Explanation, d: HouseholdDecision, context: string) {
  if (answer.context !== context) throw Error('Bulletin or household choice changed')
  return answer.mode === 'model' ? interpretReasoning(d, answer.reasoning) : ruleReasoning(d)
}
