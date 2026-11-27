import type { ChoiceOption, HouseholdDecision } from './choices'
import { explanationProtocol } from './contracts'
import {
  modeledReading, windowSamples, type Bulletin, type City, type PlanningWindow, type Profile, type WindowForecast,
} from './domain'

// Bump when the meaning of a priority, safety threshold or permitted choice
// changes. A wording edit keeps the same policy and the same identifiers.
const decisionPolicy = 1

function optionIdentity(option: ChoiceOption | null) {
  return option && { id: option.id, canLead: option.canLead === true }
}

function windowEvidence(window: PlanningWindow & { forecast: WindowForecast }, b: Bulletin | null, now: number) {
  const { period, start, end, forecast } = window
  // Bind the unrounded samples as well as the derived coverage. Two windows
  // with the same extrema can have different interior readings or gaps.
  const samples = b ? windowSamples(b, now, start, end).map(p => [p.time, p.aqi]) : []
  const { low, high, complete, previous, laterFrom } = forecast
  return {
    period, start, end, active: start <= now && now < end,
    low, high, complete, previous: previous && [previous.time, previous.aqi], laterFrom, samples,
  }
}

// A new retrieval can confirm the same facts. The Worker checks the age of
// both retrievals separately. The household enums are persisted preset IDs.
export function semanticContext(city: City, b: Bulletin | null, p: Profile, d: HouseholdDecision, now: number) {
  return JSON.stringify({
    protocol: explanationProtocol, policy: decisionPolicy, city,
    source: b && {
      city: b.city, valid: b.valid, aqi: b.aqi, pm25: b.pm25, pm10: b.pm10,
      reading: modeledReading(b, now)?.kind ?? null,
    },
    household: [p.people, p.travel, p.period, p.activity],
    outing: {
      ...windowEvidence(d.outing, b, now), kind: d.outing.kind, caution: d.outing.caution,
    },
    laterWindow: d.laterWindow && windowEvidence(d.laterWindow, b, now),
    recommended: optionIdentity(d.recommended), alternative: optionIdentity(d.alternative),
    evidence: d.evidence.map(({ option, role, id }) => [option, role, id]),
  })
}
