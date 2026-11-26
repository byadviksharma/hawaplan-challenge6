import { useEffect, useRef, useState } from 'react'
import { BookOpen, ArrowUpRight } from 'lucide-react'
import { modeledReading, type Bulletin, type City, type Profile, stamp } from './domain'
import { explanationSchema, ruleDetails } from './contracts'
import type { HouseholdDecision } from './choices'
import { evidenceRevision, resolveExplanation, ruleReasoning } from './explanationFacts'

type Result = {
  mode: 'model' | 'rules'
  created: number
  detail: string
  view: ReturnType<typeof ruleReasoning>
}
const changed = 'Conditions changed. Refresh the bulletin for a new explanation.'
const unavailable = 'The explanation service is unavailable.'

export function ExplanationBox({
  city,
  data,
  now,
  profile,
  decision,
  context,
  onRequest,
  onConflict,
}: {
  city: City
  data: Bulletin | null
  now: number
  profile: Profile
  decision: HouseholdDecision
  context: string
  onRequest: () => void
  onConflict: () => void
}) {
  const [result, setResult] = useState<Result | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const reusable = result && (
    result.mode === 'model' || result.detail === ruleDetails.current ||
    result.detail === ruleDetails.single || result.detail === ruleDetails.binding
  )
  useEffect(() => () => controller.current?.abort(), [])
  async function request() {
    if (controller.current) return
    if (reusable) {
      setOpen(!open)
      return
    }
    const abort = new AbortController()
    controller.current = abort
    onRequest()
    setBusy(true)
    let failure = unavailable
    try {
      const revision = await evidenceRevision(context)
      if (abort.signal.aborted) return
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city, profile, revision,
          valid: data?.valid ?? null,
          retrieved: data?.retrieved ?? null,
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(23_000)]),
      })
      if (abort.signal.aborted) return
      if (res.status === 409) {
        setResult(null)
        setOpen(false)
        onConflict()
        return
      }
      if (!res.ok) throw Error()
      failure = 'The explanation could not be verified.'
      const answer = explanationSchema.parse(await res.json())
      if (abort.signal.aborted) return
      if (answer.context !== context) {
        failure = changed
        throw Error()
      }
      const { mode, detail, created } = answer
      const view = resolveExplanation(answer, decision, context)
      setResult({ mode, detail, created, view })
      setOpen(true)
    } catch {
      if (!abort.signal.aborted) {
        setResult({
          mode: 'rules',
          created: Date.now(),
          detail: failure,
          view: ruleReasoning(decision),
        })
        setOpen(true)
      }
    } finally {
      if (!abort.signal.aborted) {
        controller.current = null
        setBusy(false)
      }
    }
  }
  return (
    <div className="explanation">
      <button
        id="explanation"
        className="explain-btn"
        onClick={request}
        disabled={busy}
        aria-controls="plan-explanation"
        aria-expanded={result && !reusable ? undefined : open}
        aria-describedby="explanation-privacy"
      >
        <BookOpen size={17} />
        {busy
          ? 'Preparing explanation…'
          : reusable
            ? open ? 'Hide explanation' : 'Show explanation'
            : result ? 'Explain again' : 'Explain my plan'}
        <ArrowUpRight size={16} />
      </button>
      <p className="fine" id="explanation-privacy">
        Requesting an explanation shares your city, household presets (including defaults)
        and air-quality facts with the planner and, when available, Workers AI.
      </p>
      <div aria-live="polite" id="plan-explanation">
        {open && result && (
          <div className="explanation-body">
            <h3>
              {result.mode === 'model'
                ? 'AI-composed explanation'
                : 'Rule-based explanation'}
            </h3>
            <dl className="household-options">
              <dt>Recommended</dt>
              <dd>
                <strong>{result.view.recommended.title}</strong>
                {result.view.reason && <p>{result.view.reason}</p>}
              </dd>
              {result.view.alternative && (
                <>
                  <dt>Alternative</dt>
                  <dd>
                    <strong>{result.view.alternative.title}</strong>
                    {result.view.switchWhen && <p>{result.view.switchWhen}</p>}
                  </dd>
                </>
              )}
            </dl>
            <p className="decision-basis">{decision.basis}</p>
            {result.view.limitation && <p>{result.view.limitation}</p>}
            {data && (
              <p className="decision-source">
                Open-Meteo / CAMS · {modeledReading(data, now)?.kind === 'earlier' ? 'Earlier modeled reading valid' : 'Model valid'} {stamp(data.valid)}
              </p>
            )}
            <p className="fine">
              {result.detail} · Prepared {stamp(result.created)}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
