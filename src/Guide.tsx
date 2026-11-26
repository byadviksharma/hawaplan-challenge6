import { ChevronDown, House, Footprints } from 'lucide-react'
import { travelAction } from './plan'
import type { Profile } from './domain'
export function Guide({ profile }: { profile: Profile }) {
  const travel = travelAction(profile)
  return (
    <section id="guide" className="guide" aria-labelledby="guide-title" tabIndex={-1}>
      <h2 id="guide-title">Field guide</h2>
      <div className="guide-grid">
        <details>
          <summary>
            <House size={20} /> Indoor air <ChevronDown size={16} />
          </summary>
          <p>
            <strong>Start at the source.</strong> Skip incense, tobacco smoke
            and candles indoors. Vent cooking fumes outdoors when possible.
          </p>
          <p>
            <strong>Filter the room you use.</strong> If available, use a HEPA
            cleaner sized for the room and follow its filter-change
            instructions.
          </p>
          <p>
            <strong>Time your ventilation.</strong> When outdoor pollution is
            elevated, limit extra outdoor air entry if comfortable. Air out
            rooms when outdoor conditions improve. Keep essential cooking and
            combustion ventilation working.
          </p>
          <p className="fine">
            Indoor air is unmeasured.{' '}
            <a href="https://www.epa.gov/indoor-air-quality-iaq/improving-indoor-air-quality">
              EPA indoor air guidance ↗
            </a>
          </p>
        </details>
        <details>
          <summary>
            <Footprints size={20} /> Lower-emission choices{' '}
            <ChevronDown size={16} />
          </summary>
          <p>
            <strong>{travel.title}.</strong> {travel.reason}
          </p>
          <p>
            Pair errands with an existing journey. Where available, sharing a
            ride or using public transport can reduce the number of vehicles
            making the same trip.
          </p>
          <p>
            For short trips, walking or cycling avoids tailpipe emissions. Weigh
            the outdoor conditions and your household’s needs before choosing an
            active trip.
          </p>
        </details>
      </div>
    </section>
  )
}
