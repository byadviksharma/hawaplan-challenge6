import { makeDecision } from '../src/choices'
import { modelDetail, ruleDetails, type Explanation, type ExplanationRequest, type SemanticExplanation } from '../src/contracts'
import { stale, type Bulletin } from '../src/domain'
import { decisionContext, evidenceRevision } from '../src/explanationFacts'
import { semanticContext } from '../src/explanationEvidence'
import { inferExplanation, type InferenceBindings } from './ai'
import type { LoadAir } from './air'

function matchesBulletin(input: ExplanationRequest, data: Bulletin | null) {
  if (input.valid === null) return data === null
  if (!data || data.city !== input.city || data.valid !== input.valid) return false
  // Legacy clients identify the source by retrieval time. Revision-aware
  // clients may use a newer retrieval that confirms the same source facts.
  return input.revision !== undefined || input.retrieved === undefined || data.retrieved === input.retrieved
}

function evidenceIsFresh(data: Bulletin | null, retrieved: ExplanationRequest['retrieved'], at: number) {
  if (!data) return true
  if (stale(data, at)) return false
  return retrieved == null || data.retrieved === retrieved || !stale({ ...data, retrieved }, at)
}

function decisionAt(input: ExplanationRequest, data: Bulletin | null, at: number) {
  const decision = makeDecision(data, input.profile, at)
  const context = 'protocol' in input
    ? semanticContext(input.city, data, input.profile, decision, at)
    : decisionContext(data, input.profile, decision, at)
  return { decision, context }
}

// A null result means the client's evidence no longer supports this explanation.
export async function prepareExplanation(
  input: ExplanationRequest, env: InferenceBindings, key: string, load: LoadAir,
): Promise<Explanation | SemanticExplanation | null> {
  const { city, profile, valid, retrieved, revision } = input
  const data = valid === null ? null : (await load(city)).data
  if (!matchesBulletin(input, data)) return null

  const now = Date.now()
  const { decision, context } = decisionAt(input, data, now)
  const fresh = evidenceIsFresh(data, retrieved, now)
  // The digest, limiter and model can each span a city-clock or freshness boundary.
  const evidenceStillMatches = () => {
    const at = Date.now()
    if (at === now) return true
    if (fresh && !evidenceIsFresh(data, retrieved, at)) return false
    return decisionAt(input, data, at).context === context
  }
  if (revision && (!fresh || await evidenceRevision(context) !== revision || !evidenceStillMatches())) return null

  const answer = await inferExplanation(env, data, profile, key, now, decision, evidenceStillMatches)
  if (!answer || !evidenceStillMatches()) return null

  if ('protocol' in input) return { ...answer, protocol: input.protocol, revision: input.revision }

  // Preserve both public response formats, including the original no-data
  // context for a stale bulletin requested without a retrieval timestamp.
  let legacyContext = context
  if (!revision && retrieved !== undefined)
    legacyContext = decisionContext(data, profile, decision, now, 'legacy')
  else if (data && stale(data, now))
    legacyContext = decisionContext(null, profile, decision, now)
  return answer.mode === 'model'
    ? { ...answer, context: legacyContext, detail: modelDetail }
    : { ...answer, context: legacyContext, detail: ruleDetails[answer.detail] }
}
