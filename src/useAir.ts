import { useEffect, useRef, useState } from 'react'
import { bulletinSchema, nextBulletinTick, usable, type AirStatus, type Bulletin, type City } from './domain'
export type { AirStatus as Status } from './domain'

export function readLocal(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem('hawa.v1.' + key) ?? 'null')
  } catch {
    return null
  }
}
export function saveLocal(key: string, data: unknown) {
  try {
    localStorage.setItem('hawa.v1.' + key, JSON.stringify(data))
  } catch {
    /* Private browsing or storage quota. */
  }
}
export function useAir(city: City) {
  const [result, setResult] = useState<{
    city: City
    status: AirStatus
    data: Bulletin | null
  }>({ city, status: 'loading', data: null })
  const [now, setNow] = useState(Date.now)
  const actions = useRef<{ refresh(): void; invalidate(): void } | null>(null)

  useEffect(() => {
    const key = 'air.' + city
    const saved = bulletinSchema.safeParse(readLocal(key))
    if (!saved.success) {
      try {
        localStorage.removeItem('hawa.v1.' + key)
      } catch {
        /* Storage may be read-only. */
      }
    }
    let data = saved.success && saved.data.city === city && usable(saved.data, Date.now())
      ? saved.data
      : null
    let pending: AbortController | null = null
    let timer: ReturnType<typeof setTimeout>
    function tick() {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      timer = setTimeout(tick, nextBulletinTick(data, time) - time)
    }
    function publish(status: AirStatus) {
      tick()
      setResult({ city, data, status })
    }
    function markUnverified(notice: NonNullable<Bulletin['notice']>) {
      if (data && data.notice !== notice) {
        data = { ...data, notice }
        saveLocal(key, data)
      }
    }
    async function refresh() {
      if (!navigator.onLine) {
        pending?.abort()
        pending = null
        markUnverified('cached')
        publish('offline')
        return
      }
      if (pending) return
      const controller = new AbortController()
      pending = controller
      publish(data && usable(data, Date.now()) ? 'refreshing' : 'loading')
      try {
        const response = await fetch('/api/air?city=' + city, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(14_000)]),
        })
        if (!response.ok) throw new Error(response.status === 429 ? 'rate' : 'source')
        const fresh = bulletinSchema.parse(await response.json())
        if (fresh.city !== city || !usable(fresh, Date.now())) throw new Error('source')
        if (controller.signal.aborted) return
        data = fresh
        saveLocal(key, fresh)
        publish(fresh.notice === 'rate' || fresh.notice === 'source' ? fresh.notice : 'ready')
      } catch (e) {
        if (controller.signal.aborted) return
        const status = !navigator.onLine ? 'offline' : e instanceof Error && e.message === 'rate' ? 'rate' : 'source'
        markUnverified(status === 'offline' ? 'cached' : status)
        publish(status)
      } finally {
        if (pending === controller) pending = null
      }
    }
    function invalidate() {
      // A Worker conflict supersedes both this bulletin and any earlier GET.
      pending?.abort()
      pending = null
      markUnverified('cached')
      void refresh()
    }
    actions.current = { refresh, invalidate }
    void refresh()
    const interval = setInterval(refresh, 15 * 60_000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    return () => {
      pending?.abort()
      clearTimeout(timer)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
      actions.current = null
    }
  }, [city])

  const scoped = result.city === city ? result : null
  const data = scoped?.data && usable(scoped.data, now) ? scoped.data : null
  return {
    data,
    status: scoped?.status === 'ready' && !data ? 'source' : (scoped?.status ?? 'loading'),
    now,
    retry: () => actions.current?.refresh(),
    invalidate: () => actions.current?.invalidate(),
  }
}
