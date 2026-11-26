import { bulletinSchema, usable, type City, type Bulletin } from '../src/domain'
import { fetchBulletin, refreshAfter, SourceError } from './provider'

type DataResult = { data: Bulletin | null; error?: 'rate' | 'source' }
export type LoadAir = (city: City) => Promise<DataResult>

function classifyAirFailure(error: unknown): 'rate' | 'source' {
  if (error instanceof SourceError) {
    console.warn({ event: 'provider_failure', kind: error.kind })
    return error.kind
  }
  console.error({ event: 'internal_failure', operation: 'refresh_bulletin' })
  return 'source'
}

export async function getAir(
  city: City,
  cache: Pick<Cache, 'match' | 'put'>,
  origin: string,
): Promise<DataResult> {
  const key = origin + '/internal-cache/v1/' + city
  const hit = await cache.match(key).catch(() => undefined)
  const parsed =
    hit && bulletinSchema.safeParse(await hit.json().catch(() => null))
  const now = Date.now()
  const saved =
    parsed?.success && parsed.data.city === city && usable(parsed.data, now)
      ? parsed.data
      : null
  if (saved && now - saved.retrieved < refreshAfter) return { data: saved }
  const backedOff = await cache.match(key + '/retry').catch(() => undefined)
  const fail = (kind: 'rate' | 'source'): DataResult => ({
    data: saved && usable(saved, Date.now()) ? { ...saved, notice: kind } : null,
    error: kind,
  })
  if (backedOff)
    return fail((await backedOff.text()) === 'rate' ? 'rate' : 'source')
  try {
    const data = await fetchBulletin(city)
    await cache
      .put(
        key,
        Response.json(data, {
          headers: { 'Cache-Control': 'public, max-age=86400' },
        }),
      )
      .catch(() => undefined)
    return { data }
  } catch (e) {
    const kind = classifyAirFailure(e)
    await cache
      .put(
        key + '/retry',
        new Response(kind, {
          headers: {
            'Cache-Control': 'public, max-age=' + (kind === 'rate' ? 60 : 20),
          },
        }),
      )
      .catch(() => undefined)
    return fail(kind)
  }
}
