import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { profileSchema, type Profile } from './domain'
export function Modal({
  title,
  children,
  close,
}: {
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const trigger = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onCancel={close}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current!.getBoundingClientRect()
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close()
        }
      }}
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button className="icon" onClick={close} aria-label="Close dialog">
          <X />
        </button>
      </div>
      {children}
    </dialog>
  )
}
const labels = {
  people: 'Household',
  travel: 'Usual travel',
  period: 'Preferred outing period',
  activity: 'Outdoor activity',
}
export function ProfileForm({
  profile,
  save,
  close,
}: {
  profile: Profile
  save: (value: Profile) => void
  close: () => void
}) {
  return (
    <Modal title="Your household" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const p = profileSchema.safeParse(
            Object.fromEntries(new FormData(e.currentTarget)),
          )
          if (p.success) save(p.data)
        }}
      >
        {(Object.keys(labels) as (keyof Profile)[]).map((key) => (
          <div className="field" key={key}>
            <label htmlFor={'household-' + key}>{labels[key]}</label>
            <select
              id={'household-' + key}
              name={key}
              defaultValue={profile[key]}
              aria-describedby={key === 'period' ? 'outing-help' : undefined}
            >
              {profileSchema.shape[key].options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            {key === 'period' && (
              <p id="outing-help" className="fine">
                We plan your outdoor activity and any travel for this period.
              </p>
            )}
          </div>
        ))}
        <p className="fine">
          Presets are saved in this browser. Requesting an explanation shares
          these choices and the city with the planner and, when connected,
          Workers AI.
        </p>
        <button className="primary" type="submit">
          Save household
        </button>
      </form>
    </Modal>
  )
}
