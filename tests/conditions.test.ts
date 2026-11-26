import { describe, expect, it } from 'vitest'
import { conditionsView } from '../src/conditions'
import { type Bulletin, hour } from '../src/domain'

const now = Date.parse('2026-11-24T12:30:00+05:30')
const bulletin: Bulletin = {
  city: 'delhi', valid: now, retrieved: now, aqi: 352, pm25: null, pm10: null, hours: [],
}

describe('conditions presentation', () => {
  it('distinguishes an initial load from a bulletin with a missing AQI', () => {
    expect(conditionsView(null, 'loading', now)).toMatchObject({
      label: 'Regional model', heading: 'Awaiting model data', state: 'Loading conditions', checking: true, alert: null,
    })
    expect(conditionsView({ ...bulletin, aqi: null }, 'ready', now)).toMatchObject({
      label: 'Regional model', heading: 'AQI unavailable', state: 'Modeled estimate', checking: false, alert: null,
    })
  })

  it.each([
    [now + 1, 'Upcoming modeled reading'],
    [now, 'Current conditions'],
    [now - hour + 1, 'Current conditions'],
    [now - hour, 'Earlier modeled reading'],
  ] as const)('labels the modeled instant %s during a refresh', (valid, label) => {
    expect(conditionsView({ ...bulletin, valid }, 'refreshing', now)).toMatchObject({
      label, heading: 'Hazardous', state: 'Refreshing conditions', checking: true, alert: null,
    })
  })

  it('keeps a stale time warning after a successful request and during the next refresh', () => {
    const aged = { ...bulletin, retrieved: now - hour - 1 }
    const alert = 'The source or retrieval time is outside the freshness window. Showing the last available estimate.'
    expect(conditionsView(aged, 'ready', now)).toMatchObject({
      label: 'Saved conditions', heading: 'Hazardous', state: 'Stale estimate', checking: false, alert,
    })
    expect(conditionsView(aged, 'refreshing', now)).toMatchObject({
      label: 'Saved conditions', state: 'Refreshing conditions · Stale estimate', checking: true, alert,
    })
  })

  it('explains a saved notice even with recent timestamps and no AQI', () => {
    expect(conditionsView({ ...bulletin, aqi: null, notice: 'cached' }, 'ready', now)).toMatchObject({
      label: 'Saved conditions', heading: 'AQI unavailable', state: 'Stale estimate',
      alert: 'The saved bulletin needs a fresh provider check. Showing the last available estimate.',
    })
  })

  it.each([
    ['offline', 'Offline', 'Check your connection.'],
    ['rate', 'Provider rate limit', 'The provider is limiting requests. Try again in a minute.'],
    ['source', 'Provider unavailable', 'The latest bulletin could not be retrieved.'],
  ] as const)('prioritizes the %s failure and identifies whether a saved estimate exists', (status, state, problem) => {
    expect(conditionsView(null, status, now)).toMatchObject({
      heading: 'No current reading', state, checking: false, alert: problem + ' General household actions are available below.',
    })
    expect(conditionsView({ ...bulletin, notice: 'cached' }, status, now)).toMatchObject({
      heading: 'Hazardous', state: state + ' · Stale estimate', alert: problem + ' Showing the last available estimate.',
    })
  })
})
