import { createHash } from 'node:crypto'
import { makeDecision } from '../src/choices'
import type { Bulletin, Profile } from '../src/domain'
import { semanticContext } from '../src/explanationEvidence'

// Reconstruct the Worker's revision from its source fixture, independently of the browser request.
export function sourceRevision(data: Bulletin, profile: Profile, now: number) {
  const decision = makeDecision(data, profile, now)
  const context = semanticContext(data.city, data, profile, decision, now)
  return createHash('sha256').update(context).digest('hex')
}
