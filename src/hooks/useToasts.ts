import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastItem } from '../components/common/Toast'

export type ToastFn = (msg: string, kind?: ToastItem['kind']) => number
export type DismissFn = (id: number) => void

/** Notifications that dismiss themselves after `seconds`, keeping at most `max` on screen. */
export function useToasts(seconds: number, max: number) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const prefs = useRef({ seconds, max })
  prefs.current = { seconds, max }

  const dismiss = useCallback<DismissFn>((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback<ToastFn>(
    (msg, kind = 'info') => {
      const id = ++nextId.current
      setToasts((t) => [...t, { id, msg, kind }].slice(-prefs.current.max))
      setTimeout(() => dismiss(id), prefs.current.seconds * 1000)
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    setToasts((t) => (t.length > max ? t.slice(-max) : t))
  }, [max])

  return { toasts, toast, dismiss }
}
