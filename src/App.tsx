import { useState } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  Info,
  RefreshCw,
  SlidersHorizontal,
  Sunrise,
  Sun,
  Moon,
  MapPin,
} from 'lucide-react'
import {
  category,
  cities,
  citySchema,
  defaults,
  dateIST,
  editionIST,
  profileSchema,
  sourceURL,
  spans,
  stale,
  stamp,
  type Bulletin,
  type City,
  type Profile,
} from './domain'
import { makeHouseholdPlan } from './choices'
import { decisionContext } from './explanationFacts'
import { Forecast } from './Forecast'
import { Guide } from './Guide'
import { ExplanationBox } from './Explanation'
import { Modal, ProfileForm } from './Profile'
import { conditionsView } from './conditions'
import { readLocal, saveLocal, useAir, type Status } from './useAir'

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 44 38" className="mark">
      <path d="M2 13 C15 -2 26 18 42 4 C28 25 16 6 2 13ZM2 23 C15 8 26 28 42 14 C28 35 16 16 2 23ZM2 33 C15 18 26 38 42 24 C28 45 16 26 2 33Z" />
    </svg>
  )
}
function Conditions({
  data,
  status,
  now,
  retry,
  city,
}: {
  data: Bulletin | null
  status: Status
  now: number
  retry: () => void
  city: City
}) {
  const [source, setSource] = useState(false)
  const { reading, label, state, heading, checking, alert } = conditionsView(data, status, now)
  const val = (v: number | null | undefined) =>
    v == null ? '—' : Number(v.toFixed(1))
  return (
    <section className="conditions" aria-label={label}>
      <div className="condition-grid">
        <div className="index-reading">
          <span className="band-label">US AQI</span>
          <strong data-testid="aqi">
            {reading ? Math.round(reading.aqi) : '—'}
          </strong>
        </div>
        <div className="category">
          <span className="band-label">
            {label}
          </span>
          <h2>{heading}</h2>
          <div className="condition-state" role="status">
            <i className={checking ? 'pending' : ''} />
            {state}
          </div>
        </div>
        <div className="particles">
          <div>
            <span>PM2.5</span>
            <strong>{val(data?.pm25)}</strong>
            <small>µg/m³</small>
          </div>
          <div>
            <span>PM10</span>
            <strong>{val(data?.pm10)}</strong>
            <small>µg/m³</small>
          </div>
        </div>
      </div>
      {reading?.kind === 'earlier' && (
        <p className="missing-values" role="status">This reading is at least one hour old. Current AQI is unavailable.</p>
      )}
      {reading?.kind === 'upcoming' && (
        <p className="missing-values" role="status">The model time is still ahead. Current AQI is unavailable.</p>
      )}
      {data && (data.pm25 === null || data.pm10 === null) && (
        <p className="missing-values">
          {[data.pm25 === null ? 'PM2.5' : '', data.pm10 === null ? 'PM10' : '']
            .filter(Boolean)
            .join(' and ')}{' '}
          unavailable from the model.
        </p>
      )}
      <div className="provenance">
        <div>
          <span>Open-Meteo / CAMS</span>
          <span>
            {data ? 'Model valid ' + stamp(data.valid) : 'Regional air model'}
          </span>
        </div>
        <button onClick={() => setSource(true)}>
          <Info size={15} /> Source details
        </button>
      </div>
      {alert && (
        <div className="condition-alert" role="status">
          <span>{alert}</span>
          <button onClick={retry} disabled={status === 'refreshing'}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}
      {source && (
        <Modal title="Source details" close={() => setSource(false)}>
          <dl className="source-list">
            <dt>Provider</dt>
            <dd>
              <a href={sourceURL}>Open-Meteo Air Quality API ↗</a> ·{' '}
              <a href="https://atmosphere.copernicus.eu/">
                Copernicus Atmosphere Monitoring Service ↗
              </a>
            </dd>
            <dt>Coverage</dt>
            <dd>
              CAMS global model, about 45 km resolution. Values describe
              regional outdoor conditions. Street and indoor conditions may
              differ.
            </dd>
            <dt>City centre</dt>
            <dd>
              {cities[city].name} · {cities[city].lat}° N, {cities[city].lon}° E
            </dd>
            <dt>Data type and scale</dt>
            <dd>
              Modeled estimate and hourly forecast. US AQI, with PM2.5 and PM10
              in micrograms per cubic metre. Station observations are
              unavailable in this edition.
            </dd>
            <dt>Valid time</dt>
            <dd>{data ? stamp(data.valid) : 'Unavailable'}</dd>
            {reading && !Number.isInteger(reading.aqi) && (
              <><dt>Source US AQI</dt><dd>{reading.aqi}</dd></>
            )}
            <dt>Retrieved</dt>
            <dd>{data ? stamp(data.retrieved) : 'Unavailable'}</dd>
            <dt>Freshness</dt>
            <dd>
              The global model updates about every 12 hours. The provider
              supplies hourly estimates from its three-hourly model. We check
              the provider every 15 minutes. For current advice, the model
              time must have arrived and the reading must be less than one hour old.
              Retrieving it again does not change its age. The forecast bulletin
              becomes stale when the model time is over 3 hours old or its retrieval
              is over 1 hour old. Saved estimates expire after 24 hours.
            </dd>
          </dl>
          <button
            className="plain"
            onClick={() => {
              setSource(false)
              retry()
            }}
          >
            <RefreshCw size={15} /> Refresh conditions
          </button>
        </Modal>
      )}
    </section>
  )
}
const icons = { Morning: Sunrise, Afternoon: Sun, Evening: Moon }
function Edition({
  city,
  changeCity,
  profile,
  edit,
}: {
  city: City
  changeCity: (c: City) => void
  profile: Profile
  edit: () => void
}) {
  const { data, status, now, retry, invalidate } = useAir(city)
  const [conflict, setConflict] = useState(false)
  const old = !!data && stale(data, now)
  const evidence = old ? null : data
  const { timeline, decision } = makeHouseholdPlan(evidence, profile, now)
  const context = decisionContext(evidence, profile, decision, now)
  const day = (start: number) =>
    dateIST(start) === dateIST(now) ? 'Today' : 'Tomorrow'
  const { outing } = decision
  return (
    <main id="bulletin">
      <div className="edition-line">
        <span>Household air bulletin</span>
        <time>
          {editionIST(now)} <b>·</b> IST
        </time>
      </div>
      <div className="city-row">
        <div className="city-name">
          <h1>{cities[city].name}</h1>
          <div className="city-picker">
            <ChevronDown size={23} />
            <select
              aria-label="Change city"
              value={city}
              onChange={(e) => changeCity(citySchema.parse(e.target.value))}
            >
              {citySchema.options.map((id) => (
                <option key={id} value={id}>
                  {cities[id].name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <span className="region">
          <MapPin size={15} />
          {cities[city].region}, India
        </span>
      </div>
      <Conditions key={city} {...{ data, status, now, retry, city }} />
      <nav className="reading-links" aria-label="More in this bulletin">
        <a href="#explanation">Plan explanation</a>
        <a href="#guide">Field guide</a>
      </nav>
      <div className="spread">
        <section id="plan" aria-labelledby="plan-title">
          <div className="block-head">
            <h2 id="plan-title">Your daily plan</h2>
          </div>
          <button className="profile-line" onClick={edit}>
            <span>
              {profile.people} <b>·</b> {profile.travel} <b>·</b> {profile.period}
            </span>
            <ArrowUpRight size={14} />
          </button>
          {outing.caution && outing.start !== timeline[0].start && (
            <a className="outing-warning" href={'#period-' + outing.start}>
              <strong>{day(outing.start)} · {outing.period} outing</strong>
              <span>
                {outing.forecast.high !== null && category(outing.forecast.high).label + ' forecast. '}
                {outing.title}.
              </span>
            </a>
          )}
          <ol className="timeline">
            {timeline.map((a) => {
              const Icon = icons[a.period]
              return (
                <li key={a.start} id={'period-' + a.start} tabIndex={-1}>
                  <div className="time-label">
                    <Icon size={19} />
                    <strong>{a.period}</strong>
                    <time dateTime={new Date(a.start).toISOString()} title={stamp(a.start)}>
                      {day(a.start)}{a.start <= now ? ' · Now' : ''}
                    </time>
                    <small>{spans[a.period]} IST</small>
                  </div>
                  <div>
                    <h3>{a.title}</h3>
                    <p>{a.reason}</p>
                  </div>
                </li>
              )
            })}
          </ol>
          {conflict && (
            <p className="fine" role="status">
              The bulletin changed while preparing your explanation. Review the updated plan and try again.
            </p>
          )}
          <ExplanationBox
            city={city}
            data={evidence}
            now={now}
            profile={profile}
            decision={decision}
            context={context}
            onRequest={() => setConflict(false)}
            onConflict={() => {
              setConflict(true)
              invalidate()
            }}
          />
        </section>
        <aside>
          <Forecast key={city} data={data} now={now} />
        </aside>
      </div>
      <Guide profile={profile} />
    </main>
  )
}
export function App() {
  const [city, setCity] = useState<City>(
    () => citySchema.safeParse(readLocal('city')).data ?? 'delhi',
  )
  const [profile, setProfile] = useState<Profile>(
    () => profileSchema.safeParse(readLocal('profile')).data ?? defaults,
  )
  const [editing, setEditing] = useState(false)
  return (
    <div className="paper">
      <a className="skip" href="#plan">
        Skip to daily plan
      </a>
      <header>
        <a className="brand" href="#bulletin">
          <Mark />
          HawaPlan
        </a>
        <nav aria-label="Bulletin sections">
          <a href="#plan">Daily plan</a>
          <a href="#forecast">Forecast</a>
          <a href="#guide">Field guide</a>
        </nav>
        <button className="household" onClick={() => setEditing(true)}>
          <SlidersHorizontal size={16} /> Household
        </button>
      </header>
      <Edition
        key={city}
        city={city}
        changeCity={(c) => {
          setCity(c)
          saveLocal('city', c)
        }}
        profile={profile}
        edit={() => setEditing(true)}
      />
      <footer>
        <span>
          <Mark /> HawaPlan
        </span>
        <a href={sourceURL}>Air data by Open-Meteo &amp; CAMS ↗</a>
      </footer>
      {editing && (
        <ProfileForm
          profile={profile}
          close={() => setEditing(false)}
          save={(p) => {
            setProfile(p)
            saveLocal('profile', p)
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}
