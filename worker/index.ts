import {
  bulletinSchema,
  citySchema,
  stale,
  usable,
  type City,
  type Bulletin,
} from '../src/domain'
import { requestSchema } from '../src/contracts'
import { makeDecision } from '../src/choices'
import { decisionContext, evidenceRevision } from '../src/explanationFacts'
import {
  boundedJSON,
  fetchBulletin,
  refreshAfter,
  SourceError,
} from './provider'
import { explain, type InferenceBindings } from './ai'

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
type DataResult = { data: Bulletin | null; error?: 'rate' | 'source' }
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
    const kind = e instanceof SourceError ? e.kind : 'source'
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
export async function route(
  request: Request,
  env: InferenceBindings,
  load: (city: City) => Promise<DataResult>,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/air') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405)
    const city = citySchema.safeParse(url.searchParams.get('city'))
    if (!city.success) return json({ error: 'city' }, 400)
    const r = await load(city.data)
    return r.data
      ? json(r.data)
      : json({ error: r.error }, r.error === 'rate' ? 429 : 503)
  }
  if (url.pathname !== '/api/explain') return json({ error: 'not-found' }, 404)
  if (request.method !== 'POST') return json({ error: 'method' }, 405)
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== url.origin
  )
    return json({ error: 'origin' }, 403)
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'format' }, 415)
  let raw: unknown
  try {
    raw = await boundedJSON(
      new Response(request.body, { headers: request.headers }),
      2048,
    )
  } catch (e) {
    return json({ error: 'input' }, e instanceof RangeError ? 413 : 400)
  }
  const input = requestSchema.safeParse(raw)
  if (!input.success) return json({ error: 'input' }, 400)
  const { city, valid, retrieved, profile, revision } = input.data
  const { data } = valid === null ? { data: null } : await load(city)
  const changed = () => json({ error: 'changed' }, 409)
  if (valid !== null && (!data || data.city !== city || data.valid !== valid)) return changed()
  // Older clients identify the bulletin by retrieval time. A revision-aware
  // client can accept newly retrieved, identical evidence while both are fresh.
  if (!revision && data && retrieved !== undefined && data.retrieved !== retrieved) return changed()
  const displayed = data && retrieved != null ? { ...data, retrieved } : data
  const freshAt = (at: number) => !data || (
    !stale(data, at) && !!displayed && usable(displayed, at) && !stale(displayed, at)
  )
  const now = Date.now()
  const decision = makeDecision(data, profile, now)
  const context = decisionContext(data, profile, decision, now)
  if (revision && (!freshAt(now) || await evidenceRevision(context) !== revision)) return changed()
  const answer = await explain(
    env, data, profile, request.headers.get('cf-connecting-ip') ?? 'local', now, decision,
  )
  // The model may have been working while the source expired or the selected
  // outing ended. Discard its reply if the current planner no longer agrees.
  const finished = Date.now()
  if (finished !== now && ((freshAt(now) && !freshAt(finished)) ||
      decisionContext(data, profile, makeDecision(data, profile, finished), finished) !== context)) return changed()
  // Clients using the earlier request format also verify the previous retrieval-bearing DTO.
  if (!revision && retrieved !== undefined) {
    return json({ ...answer, context: decisionContext(data, profile, decision, now, 'legacy') })
  }
  return json(answer)
}
export default {
  async fetch(request: Request, env: InferenceBindings) {
    try {
      const cache = caches.default
      return await route(request, env, (city) =>
        getAir(city, cache, new URL(request.url).origin),
      )
    } catch {
      return json({ error: 'source' }, 503)
    }
  },
}
