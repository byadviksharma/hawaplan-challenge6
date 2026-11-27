import { useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, ArrowUpRight } from 'lucide-react'
import { modeledReading, type Bulletin, type City, type Profile, stamp } from './domain'
import { explanationProtocol, modelDetail, ruleDetails, semanticExplanationSchema, type SemanticExplanation } from './contracts'
import type { HouseholdDecision } from './choices'
import { evidenceRevision, interpretReasoning, ruleReasoning } from './explanationFacts'

type Result = {
  mode: 'model' | 'rules'
  created: number
  detail: SemanticExplanation['detail'] | 'changed' | 'unavailable' | 'invalid'
  view: ReturnType<typeof ruleReasoning>
}
type ExplanationState = {
  context: string
  result: Result | null
  open: boolean
  busy: boolean
}
const details = {
  ...ruleDetails, model: modelDetail,
  changed: 'Conditions changed. Refresh the bulletin for a new explanation.',
  unavailable: 'The explanation service is unavailable.',
  invalid: 'The explanation could not be verified.',
}

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
  const [state, setState] = useState<ExplanationState | null>(null)
  const { result, open, busy } = state ?? { result: null, open: false, busy: false }
  const controller = useRef<AbortController | null>(null)
  const reusable = result && (
    result.mode === 'model' || result.detail === 'current' ||
    result.detail === 'single' || result.detail === 'binding'
  )
  useLayoutEffect(() => () => {
    controller.current?.abort()
    controller.current = null
  }, [context])
  // Clear the previous decision's state before React commits the new bulletin.
  if (state && state.context !== context) setState(null)
  async function request() {
    if (controller.current) return
    if (reusable) {
      setState({ context, result, open: !open, busy: false })
      return
    }
    const abort = new AbortController()
    controller.current = abort
    onRequest()
    setState({ context, result, open, busy: true })
    const show = (result: Result) => setState({ context, result, open: true, busy: false })
    let failure: Result['detail'] = 'unavailable'
    try {
      const revision = await evidenceRevision(context)
      if (abort.signal.aborted) return
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: explanationProtocol, city, profile, revision,
          valid: data?.valid ?? null,
          retrieved: data?.retrieved ?? null,
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(23_000)]),
      })
      if (abort.signal.aborted) return
      if (res.status === 409) {
        setState(null)
        onConflict()
        return
      }
      if (!res.ok) throw Error()
      failure = 'invalid'
      const answer = semanticExplanationSchema.parse(await res.json())
      if (abort.signal.aborted) return
      if (answer.revision !== revision) {
        failure = 'changed'
        throw Error()
      }
      const { mode, detail, created } = answer
      const view = mode === 'model' ? interpretReasoning(decision, answer.reasoning) : ruleReasoning(decision)
      show({ mode, detail, created, view })
    } catch {
      if (!abort.signal.aborted) {
        show({
          mode: 'rules',
          created: Date.now(),
          detail: failure,
          view: ruleReasoning(decision),
        })
      }
    } finally {
      if (!abort.signal.aborted) controller.current = null
    }
  }
  return (
    <div className="explanation">
      <button
        id="explanation"
        className="explain-btn"
        onClick={request}
        aria-disabled={busy}
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
      <div aria-live="polite" aria-busy={busy} id="plan-explanation">
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
              {details[result.detail]} · Prepared {stamp(result.created)}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
