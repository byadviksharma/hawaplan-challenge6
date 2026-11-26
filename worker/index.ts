import { citySchema } from '../src/domain'
import { requestSchema, type ExplanationRequest } from '../src/contracts'
import { getAir, type LoadAir } from './air'
import { boundedJSON, isInvalidBody } from './body'
import { prepareExplanation } from './explanation'
import type { InferenceBindings } from './ai'

export { getAir }

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

async function serveAir(url: URL, load: LoadAir) {
  const city = citySchema.safeParse(url.searchParams.get('city'))
  if (!city.success) return json({ error: 'city' }, 400)
  const { data, error } = await load(city.data)
  if (data) return json(data)
  return json({ error }, error === 'rate' ? 429 : 503)
}

async function readExplanationRequest(request: Request, origin: string): Promise<ExplanationRequest | Response> {
  const caller = request.headers.get('origin')
  if (caller && caller !== origin) return json({ error: 'origin' }, 403)
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    return json({ error: 'format' }, 415)
  let raw: unknown
  try {
    raw = await boundedJSON(new Response(request.body, { headers: request.headers }), 2048)
  } catch (error) {
    if (!isInvalidBody(error)) console.error({ event: 'internal_failure', operation: 'read_request_body' })
    return json({ error: 'input' }, error instanceof RangeError ? 413 : 400)
  }
  const input = requestSchema.safeParse(raw)
  return input.success ? input.data : json({ error: 'input' }, 400)
}

async function serveExplanation(request: Request, origin: string, env: InferenceBindings, load: LoadAir) {
  const input = await readExplanationRequest(request, origin)
  if (input instanceof Response) return input
  const key = request.headers.get('cf-connecting-ip') ?? 'local'
  const answer = await prepareExplanation(input, env, key, load)
  return answer ? json(answer) : json({ error: 'changed' }, 409)
}

export async function route(request: Request, env: InferenceBindings, load: LoadAir): Promise<Response> {
  const url = new URL(request.url)
  switch (url.pathname) {
    case '/api/air':
      if (request.method !== 'GET') return json({ error: 'method' }, 405)
      return serveAir(url, load)
    case '/api/explain':
      if (request.method !== 'POST') return json({ error: 'method' }, 405)
      return serveExplanation(request, url.origin, env, load)
    default:
      return json({ error: 'not-found' }, 404)
  }
}

export default {
  async fetch(request: Request, env: InferenceBindings) {
    try {
      return await route(request, env, city => getAir(city, caches.default, new URL(request.url).origin))
    } catch {
      console.error({ event: 'internal_failure', operation: 'handle_request' })
      return json({ error: 'source' }, 503)
    }
  },
}
