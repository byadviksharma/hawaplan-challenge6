import { makeDecision } from '../src/choices'
import type { Explanation, ExplanationRequest } from '../src/contracts'
import { stale, type Bulletin, type Profile } from '../src/domain'
import { decisionContext, evidenceRevision } from '../src/explanationFacts'
import { explain, type InferenceBindings } from './ai'
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

function decisionAt(data: Bulletin | null, profile: Profile, at: number) {
  const decision = makeDecision(data, profile, at)
  return { decision, context: decisionContext(data, profile, decision, at) }
}

// A null result means the client's evidence no longer supports this explanation.
export async function prepareExplanation(
  input: ExplanationRequest, env: InferenceBindings, key: string, load: LoadAir,
): Promise<Explanation | null> {
  const { city, profile, valid, retrieved, revision } = input
  const data = valid === null ? null : (await load(city)).data
  if (!matchesBulletin(input, data)) return null

  const now = Date.now()
  const { decision, context } = decisionAt(data, profile, now)
  const fresh = evidenceIsFresh(data, retrieved, now)
  if (revision && (!fresh || await evidenceRevision(context) !== revision)) return null

  const answer = await explain(env, data, profile, key, now, decision)
  const finished = Date.now()
  if (finished !== now) {
    if (fresh && !evidenceIsFresh(data, retrieved, finished)) return null
    if (decisionAt(data, profile, finished).context !== context) return null
  }

  // Preserve the retrieval-bearing response context for earlier clients.
  if (!revision && retrieved !== undefined)
    return { ...answer, context: decisionContext(data, profile, decision, now, 'legacy') }
  return answer
}
