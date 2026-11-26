import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  dateIST,
  forecastSummary,
  hour,
  outlookPoints,
  startOfDayIST,
  timeIST,
  type Bulletin,
  type Point,
} from './domain'

function Plot({ points, now }: { points: Point[]; now: number }) {
  const vals = points.flatMap((p) => (p.aqi === null ? [] : [p.aqi]))
  // Anchor the plot at zero so a few AQI points do not fill its whole height.
  const max = Math.max(100, Math.ceil(Math.max(...vals) / 100) * 100)
  const start = points[0].time,
    end = points.at(-1)!.time
  const midnight = startOfDayIST(end)
  const crossesMidnight = start < midnight
  const x = (t: number) => 34 + (272 * (t - start)) / (end - start || 1)
  const y = (v: number) => 92 - (80 * v) / max
  let path = '',
    prev = 0
  for (const p of points) {
    if (p.aqi === null) {
      prev = 0
      continue
    }
    const consecutive = p.time - prev === hour
    const crossesNow = prev < now && now < p.time
    path += (consecutive && !crossesNow ? 'L' : 'M') + x(p.time) + ' ' + y(p.aqi) + ' '
    prev = p.time
  }
  return (
    <svg
      className="plot"
      viewBox={crossesMidnight ? '0 -12 328 131' : '0 0 328 119'}
      role="img"
      aria-label={crossesMidnight
        ? `Modeled US AQI, ${dateIST(start)} into ${dateIST(end)}. The vertical line marks midnight IST.`
        : `Modeled US AQI on ${dateIST(start)}. Hourly values are in the table below.`}
    >
      {[max, max / 2, 0].map((v) => (
        <g key={v}>
          <line x1="34" x2="306" y1={y(v)} y2={y(v)} className="gridline" />
          <text x="24" y={y(v) + 4} textAnchor="end">
            {Math.round(v)}
          </text>
        </g>
      ))}
      {crossesMidnight && (
        <g>
          <line x1={x(midnight)} x2={x(midnight)} y1="6" y2="94" className="day-boundary" />
          <text x={x(midnight)} y="0" textAnchor={x(midnight) < 170 ? 'start' : 'end'}>
            00:00 · {dateIST(midnight)}
          </text>
        </g>
      )}
      <path d={path} className="line" />
      {points.map(
        (p) =>
          p.aqi !== null && (
            <circle key={p.time} cx={x(p.time)} cy={y(p.aqi)} r="2.6" />
          ),
      )}
      {[start, points[Math.floor(points.length / 2)].time, end]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((t) => (
          <text key={t} x={x(t)} y="114" textAnchor="middle">
            {timeIST(t)}
          </text>
        ))}
    </svg>
  )
}
export function Forecast({
  data,
  now,
}: {
  data: Bulletin | null
  now: number
}) {
  const [length, setLength] = useState(12)
  const end = now + length * hour
  const points = outlookPoints(data, now, end)
  const valid = points.filter(
    (p): p is { time: number; aqi: number } => p.aqi !== null,
  )
  return (
    <section
      id="forecast"
      className="forecast"
      aria-labelledby="forecast-title"
    >
      <div className="block-head">
        <h2 id="forecast-title">Hourly outlook</h2>
      </div>
      <div className="chart-controls">
        <span className="meta">Modeled US AQI · IST</span>
        <div className="segments" role="group" aria-label="Forecast horizon">
          {[12, 24].map((v) => (
            <button
              aria-pressed={length === v}
              onClick={() => setLength(v)}
              key={v}
            >
              {v}h
            </button>
          ))}
        </div>
      </div>
      {valid.length > 0 && <Plot points={points} now={now} />}
      <p className="chart-note">{forecastSummary(data, now, end)}</p>
      {!!points.length && (
        <details>
          <summary>
            View hourly values <ChevronDown size={16} />
          </summary>
          <div
            className="table-scroll"
            role="region"
            aria-label="Hourly forecast values"
            tabIndex={0}
          >
            <table>
              <caption>
                Regional forecast · India Standard Time. Each value is modeled
                for its timestamp.
                {points[0].time < now && ' The first row shows an earlier forecast for context.'}
              </caption>
              <thead>
                <tr>
                  <th>Local date &amp; time</th>
                  <th>US AQI</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.time}>
                    <td>
                      {dateIST(p.time)} · {timeIST(p.time)}
                      {p.time < now && ' · Earlier forecast'}
                    </td>
                    <td>{p.aqi ?? 'Unavailable'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}
