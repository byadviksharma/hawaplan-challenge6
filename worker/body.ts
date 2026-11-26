class BodyReadError extends Error {}
class BodySizeError extends RangeError {}

export function isInvalidBody(error: unknown) {
  return error instanceof SyntaxError || error instanceof BodyReadError || error instanceof BodySizeError
}

function unreadable(cause: unknown): never {
  // The request contract has always mapped range failures while reading to 413.
  if (cause instanceof RangeError) throw new BodySizeError('Body range error')
  throw new BodyReadError('Unreadable body')
}

export async function boundedJSON(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit)
    throw new BodySizeError('Size limit')
  const reader = response.body?.getReader()
  if (!reader) throw new BodyReadError('Empty body')
  const decoder = new TextDecoder()
  let size = 0,
    content = ''
  try {
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        unreadable(error)
      }
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        try {
          await reader.cancel()
        } catch (error) {
          unreadable(error)
        }
        throw new BodySizeError('Size limit')
      }
      content += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(content + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}
