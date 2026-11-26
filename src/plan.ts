import {
  category,
  currentDuring,
  dateIST,
  earlierForecastText,
  modeledReading,
  periods,
  planningWindows,
  stamp,
  timeIST,
  windowForecast,
  type Bulletin,
  type PlanningWindow,
  type Profile,
  type WindowForecast,
} from './domain'

export type Action = PlanningWindow & {
  kind: 'outing' | 'preparation' | 'indoor'
  forecast: WindowForecast
  caution: boolean
  title: string
  reason: string
}
export function actionLabel(a: Pick<PlanningWindow, 'period' | 'start'>) {
  return a.period + ' · ' + dateIST(a.start)
}

export function travelAction(p: Profile) {
  switch (p.travel) {
    case 'Car or two-wheeler':
      return {
        title: 'Combine stops into one trip',
        preparation: 'Map essential stops from home. Combining trips can avoid a separate vehicle start.',
        reason:
          'A single outing can avoid a separate vehicle start and an extra journey.',
      }
    case 'Public transport':
      return {
        title: 'Plan your stop before leaving',
        preparation: 'Look up departures from home so you can spend less time waiting by traffic.',
        reason:
          'Checking departures can shorten the wait beside busy traffic. A shared service can replace a separate car trip.',
      }
    case 'Walk or cycle':
      return {
        title: 'Choose a quieter street if available',
        preparation: 'Check the forecast and quieter route options from home before deciding whether to travel.',
        reason:
          'Moving away from queues of idling vehicles can reduce contact with roadside exhaust.',
      }
    case 'Work from home':
      return {
        title: 'Group deliveries and errands',
        preparation: 'Group household deliveries from home to avoid extra journeys.',
        reason:
          'An at-home day gives you room to combine trips that might otherwise need separate journeys.',
      }
  }
}
const activities: Record<Profile['activity'], string> = {
  'A walk': 'your walk',
  'Outdoor exercise': 'outdoor exercise',
  Playtime: 'playtime',
  Errands: 'errands',
}
const protectiveTitles: Record<Profile['activity'], string> = {
  'A walk': 'Choose an indoor alternative to your walk',
  'Outdoor exercise': 'Move exercise indoors',
  Playtime: 'Move playtime indoors',
  Errands: 'Postpone optional errands',
}

function indoorAction(p: Profile) {
  if (p.people === 'With children')
    return {
      title: 'Set up a smoke-free play space',
      reason: 'Skip incense and candles where children spend time. Removing the source helps keep particles out of the room.',
    }
  if (p.people === 'With older adults')
    return {
      title: 'Prepare the room used most',
      reason: 'If available, run a room-sized HEPA cleaner where the household spends the most time together.',
    }
  return {
    title: 'Keep cooking smoke out of living areas',
    reason: 'Use an exhaust hood that vents outdoors if available, and avoid burning incense while preparing meals.',
  }
}

function outingAction(
  b: Bulletin | null,
  p: Profile,
  w: PlanningWindow,
  forecast: WindowForecast,
  now: number,
) {
  const { low, high, complete, previous, laterFrom } = forecast
  const limit = p.people === 'Adults' ? 3 : 2
  const current = currentDuring(b, w, now)
  const forecastWarning = high !== null && category(high).level >= limit
  const currentWarning = current !== null && category(current).level >= limit
  const earlierWarning = previous !== undefined && category(previous.aqi).level >= limit
  const caution = forecastWarning || currentWarning || earlierWarning
  const activity = activities[p.activity]
  const facts: string[] = []
  if (previous) facts.push(earlierForecastText(previous))
  const needsCurrent = w.start <= now && current === null
  if (needsCurrent) {
    facts.push('Current modeled US AQI is unavailable for this outing.')
    const reading = modeledReading(b, now)
    if (reading?.kind === 'earlier')
      facts.push('The earlier modeled reading at ' + stamp(reading.time) + ' was ' +
        reading.aqi + ' US AQI (' + category(reading.aqi).label + ').')
  }
  if (currentWarning)
    facts.push('The current modeled US AQI is ' + Math.round(current) +
      ' (' + category(current).label + ').')
  if (low !== null) {
    const range = Math.round(low) === Math.round(high)
      ? String(Math.round(high))
      : Math.round(low) + '–' + Math.round(high)
    const timing = laterFrom === undefined
      ? 'The regional ' + w.period.toLowerCase() + ' forecast'
      : 'The later ' + w.period.toLowerCase() + ' forecast from ' + timeIST(laterFrom) + ' IST'
    facts.push(timing + ' is ' + range + ' US AQI (' + category(high).label + ' at the high end).')
    if (!complete)
      facts.push('Hourly coverage is incomplete. Recheck before heading outdoors.')
  } else {
    facts.push('The hourly forecast does not cover this outing. Recheck before heading outdoors.')
  }
  const evidence = facts.join(' ')
  if (caution) {
    if (earlierWarning && !forecastWarning && !currentWarning)
      return { caution, title: protectiveTitles[p.activity] + ' for now', reason: evidence }
    const alternative = p.activity === 'Errands'
      ? 'If the trip is essential, keep outdoor time brief.'
      : 'Use an indoor alternative during the selected outing period.'
    return { caution, title: protectiveTitles[p.activity], reason: evidence + ' ' + alternative }
  }
  if (!complete) {
    return { caution, title: 'Recheck the forecast before ' + activity, reason: evidence }
  }
  if (needsCurrent)
    return { caution, title: 'Recheck conditions before ' + activity,
      reason: evidence + ' Use the forecast to plan ahead and check conditions before going outdoors.' }
  let title = 'Keep ' + activity + ' flexible'
  if (p.people === 'With children') title = 'Build breaks into ' + activity
  if (p.people === 'With older adults')
    title = {
      'A walk': 'Plan a walk with a place to rest',
      'Outdoor exercise': 'Leave room for a lighter exercise session',
      Playtime: 'Keep playtime close to a resting place',
      Errands: 'Keep the errand list short',
    }[p.activity]
  return { caution, title, reason: evidence + ' Check local conditions before leaving.' }
}

export function makePlan(b: Bulletin | null, p: Profile, now: number): Action[] {
  const windows = planningWindows(now)
  // Keep the other activities in the same periods as the day rolls forward.
  const indoor = periods.find((period) => period !== p.period)
  return windows.map((w) => {
    const forecast = windowForecast(b, now, w.start, w.end)
    if (w.period === p.period) {
      return { ...w, forecast, kind: 'outing', ...outingAction(b, p, w, forecast, now) }
    }
    if (w.period === indoor) {
      return { ...w, forecast, kind: 'indoor', caution: false, ...indoorAction(p) }
    }
    return {
      ...w,
      forecast,
      kind: 'preparation',
      caution: false,
      title: 'Plan essential trips from home',
      reason: travelAction(p).preparation,
    }
  })
}
