import { category, modeledReading, stale, type AirStatus, type Bulletin } from './domain'

const requestStates: Record<AirStatus, { label: string; problem?: string }> = {
  loading: { label: 'Loading conditions' },
  refreshing: { label: 'Refreshing conditions' },
  ready: { label: 'Modeled estimate' },
  offline: { label: 'Offline', problem: 'Check your connection.' },
  rate: { label: 'Provider rate limit', problem: 'The provider is limiting requests. Try again in a minute.' },
  source: { label: 'Provider unavailable', problem: 'The latest bulletin could not be retrieved.' },
}

const readingLabels = {
  current: 'Current conditions',
  earlier: 'Earlier modeled reading',
  upcoming: 'Upcoming modeled reading',
  saved: 'Saved conditions',
  missing: 'Regional model',
}

export function conditionsView(data: Bulletin | null, status: AirStatus, now: number) {
  const reading = modeledReading(data, now)
  const saved = data !== null && stale(data, now)
  const kind = saved ? 'saved' : reading?.kind ?? 'missing'
  const missingHeading = status === 'loading' ? 'Awaiting model data' :
    data ? 'AQI unavailable' : 'No current reading'

  let { label: state, problem } = requestStates[status]
  if (saved) {
    state = status === 'ready' ? 'Stale estimate' : state + ' · Stale estimate'
    problem ??= data.notice ? 'The saved bulletin needs a fresh provider check.' :
      'The source or retrieval time is outside the freshness window.'
  }
  const availability = data ? 'Showing the last available estimate.' :
    'General household actions are available below.'
  return {
    reading,
    label: readingLabels[kind],
    heading: reading ? category(reading.aqi).label : missingHeading,
    state,
    checking: status === 'loading' || status === 'refreshing',
    alert: problem ? problem + ' ' + availability : null,
  }
}
