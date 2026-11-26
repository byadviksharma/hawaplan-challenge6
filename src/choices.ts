import {
  category, comparablePeriod, currentDuring, dateIST, hour, materiallyLower,
  windowForecast, windowsThroughTomorrow, type Bulletin, type Profile,
} from './domain'
import { actionLabel, makePlan, type Action } from './plan'

export type ChoiceOption = { id: string; title: string; canLead?: boolean }
export type ChoiceEvidence = {
  option: string
  id: string
  role: 'fit' | 'tradeoff' | 'limit'
  text: string
}
export type HouseholdDecision = {
  outing: Action
  recommended: ChoiceOption
  alternative: ChoiceOption | null
  basis: string
  evidence: ChoiceEvidence[]
}

type Candidate = ChoiceOption & {
  fit: Record<string, string>
  tradeoff: Record<string, string>
  limit: Record<string, string>
}

const regional = 'The regional forecast can differ from conditions along your route.'
const indoorLimit = 'The bulletin has no indoor air measurement.'
const activityNames: Record<Profile['activity'], string> = {
  'A walk': 'your walk', 'Outdoor exercise': 'exercise', Playtime: 'playtime', Errands: 'errands',
}

function indoorOption(p: Profile, outing: Action): Candidate {
  const activity = activityNames[p.activity]
  const fit: Record<string, string> = {
    'indoor-activity': 'doing the activity without an outdoor outing',
  }
  if (p.travel === 'Work from home')
    fit['at-home'] = 'staying at home for the activity on a work-from-home day'
  if (p.activity === 'Playtime' && p.people === 'With children')
    fit['smoke-free-play'] = 'setting up a play space away from incense and candles'
  return {
    id: 'indoor', title: outing.caution ? outing.title :
      p.activity === 'A walk' ? 'Choose an indoor activity at home' : 'Move ' + activity + ' indoors',
    fit: outing.caution
      ? { 'keeps-period': 'keeping the activity in your chosen period', ...fit }
      : fit,
    tradeoff: { 'changes-setting': 'The activity moves indoors for this period.' },
    limit: { 'no-indoor-reading': indoorLimit },
  }
}

function laterOption(b: Bulletin, p: Profile, outing: Action, now: number) {
  const selected = outing.forecast
  if (selected.low === null || !comparablePeriod(outing, selected, now)) return null
  const current = currentDuring(b, outing, now)
  if (current !== null && category(current).level >= 2 && current > selected.high) return null

  // Stay within the chart's 24h horizon. Only a complete later period with a
  // Good/Moderate high can be offered, even when an adult preset is more permissive.
  for (const w of windowsThroughTomorrow(now)) {
    if (w.start < outing.end || w.end > now + 24 * hour) continue
    const f = windowForecast(b, now, w.start, w.end)
    if (f.high === null || !comparablePeriod(w, f, now) || category(f.high).level >= 2 ||
        !materiallyLower(selected.low, f.high)) continue
    const range = String(Math.round(f.low)) +
      (Math.round(f.low) === Math.round(f.high) ? '' : '–' + Math.round(f.high))
    const when = w.period.toLowerCase() + ' on ' + dateIST(w.start)
    const option: Candidate = {
      id: 'later-period',
      title: 'Consider ' + activityNames[p.activity] + ' outdoors in the ' + when,
      fit: outing.caution ? {
        'keeps-outdoor-activity': 'keeping ' + activityNames[p.activity] + ' outdoors',
        'lower-period': 'waiting for a lower regional forecast',
      } : { 'lower-period': 'waiting for a lower regional forecast' },
      tradeoff: { 'changes-period': 'This would move the outing beyond your chosen period.' },
      limit: { 'recheck-later': 'Check the forecast again before changing your plans.' },
    }
    return { option, basis: 'The ' + when + ' has a regional forecast of ' +
      range + ' US AQI (' + category(f.high).label + ' at the high end).' }
  }
  return null
}

function errandOptions(outing: Action, p: Profile): [Candidate, Candidate | null] {
  if (outing.caution) {
    return [{
      id: 'postpone', title: outing.title,
      fit: { 'postpones-optional-stops': 'leaving optional errands until another day or period' },
      tradeoff: { 'leaves-errands-outstanding': 'Optional stops stay on the list for later.' },
      limit: { 'regional-forecast': regional },
    }, {
      id: 'essential-only', title: 'If a stop cannot wait, keep the essential trip brief',
      fit: { 'brief-essential-trip': 'taking care of a stop that cannot wait' },
      tradeoff: { 'requires-outing': 'An essential trip still involves going out during the advisory.' },
      limit: { 'no-route-estimate': 'The regional model cannot tell you the conditions at an individual stop.' },
    }]
  }
  const short: Candidate = {
    id: 'short-list', title: 'Keep the errand list short',
    fit: { 'short-list': 'limiting how many stops the household takes on at once' },
    tradeoff: { 'leaves-errands-outstanding': 'Any remaining errands would wait for another outing.' },
    limit: { 'regional-forecast': regional },
  }
  if (p.travel !== 'Car or two-wheeler') {
    if (p.travel === 'Public transport') {
      short.title = 'Plan departures for a short list of errands'
      short.fit['transit-wait'] = 'checking departures before heading to a stop'
    }
    return [short, null]
  }
  short.fit['return-after-priority-stop'] = 'being free to head home after the priority stop'
  short.tradeoff['another-trip'] = 'Leaving a necessary stop for later could mean a separate vehicle trip.'
  const combined: Candidate = {
    id: 'combine-stops', title: 'Combine necessary stops if they fit one trip',
    fit: {
      'avoids-extra-trip': 'avoiding a separate vehicle trip for another necessary stop',
      'finishes-list': 'getting several necessary errands off the list in the same outing',
    },
    tradeoff: {
      'adds-stops': 'Combining stops puts more errands into the same outing.',
      'coordinate-stops': 'The stops need to fit together before a combined trip makes sense.',
    },
    limit: { 'no-route-estimate': 'The bulletin has no route or travel-time estimate for your stops.' },
  }
  // The older-adult timeline gives the short list priority. Other households
  // that travel by vehicle can group necessary stops if they fit one outing.
  return p.people === 'With older adults' ? [short, combined] : [combined, { ...short, canLead: true }]
}

function candidates(outing: Action, p: Profile): [Candidate, Candidate | null] {
  if (p.activity === 'Errands') return errandOptions(outing, p)
  const indoor = indoorOption(p, outing)
  if (outing.caution) return [indoor, null]
  const outside: Candidate = {
    id: 'selected-outing', title: outing.title,
    fit: { 'keeps-outdoor-activity': 'keeping ' + activityNames[p.activity] + ' outdoors' },
    tradeoff: { 'depends-on-local-conditions': 'Going outdoors still calls for a check of local conditions.' },
    limit: { 'regional-forecast': regional },
  }
  // A low forecast alone supplies no reason to manufacture a competing plan.
  // For elevated, covered periods the indoor version is feasible in its own right.
  return [outside, outing.forecast.high !== null && category(outing.forecast.high).level >= 1
    ? { ...indoor, canLead: true } : null]
}

export function makeHouseholdPlan(b: Bulletin | null, p: Profile, now: number) {
  const timeline = makePlan(b, p, now)
  const outing = timeline.find(row => row.kind === 'outing')
  if (!outing) throw new Error('No outing for the selected household period')
  return { timeline, decision: decideOuting(b, p, now, outing) }
}

export function makeDecision(b: Bulletin | null, p: Profile, now: number): HouseholdDecision {
  return makeHouseholdPlan(b, p, now).decision
}

function decideOuting(
  b: Bulletin | null,
  p: Profile,
  now: number,
  outing: Action,
): HouseholdDecision {
  const decision: HouseholdDecision = {
    outing, recommended: { id: 'recheck', title: outing.title },
    alternative: null, basis: actionLabel(outing) + ' · ' + outing.reason, evidence: [],
  }
  // A sampled high still retains the planner's protective headline. Partial,
  // stale or absent coverage never supports a comparison between outings.
  const needsCurrent = outing.start <= now && currentDuring(b, outing, now) === null
  if (!b || !outing.forecast.complete || needsCurrent) {
    if (outing.caution) decision.recommended.id = p.activity === 'Errands' ? 'postpone' : 'indoor'
    decision.evidence.push({
      option: decision.recommended.id, role: 'limit',
      id: needsCurrent ? 'current-unavailable' : 'coverage-gap',
      text: needsCurrent ? 'Check current conditions before choosing an outdoor option.' :
        'Check for a fresh, complete forecast before choosing an outdoor option.',
    })
    return decision
  }

  const [primary, initialAlternative] = candidates(outing, p)
  let alternative = initialAlternative
  if (p.activity !== 'Errands') {
    const later = laterOption(b, p, outing, now)
    if (later) {
      alternative = later.option
      // Both options are outdoors here. Only the scheduled outing keeps the
      // preferred time, and only the later one offers the lower forecast.
      if (!outing.caution) primary.fit = { 'keeps-period': 'keeping the outing in your chosen period' }
      decision.basis += ' ' + later.basis
    }
  }
  const record = (option: Candidate): ChoiceOption => {
    for (const role of ['fit', 'tradeoff', 'limit'] as const) {
      for (const [id, text] of Object.entries(option[role]))
        decision.evidence.push({ option: option.id, id, role, text })
    }
    return { id: option.id, title: option.title, ...(option.canLead ? { canLead: true } : {}) }
  }
  decision.recommended = record(primary)
  decision.alternative = alternative && record(alternative)
  return decision
}
