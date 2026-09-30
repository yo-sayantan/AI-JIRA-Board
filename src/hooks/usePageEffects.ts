import { useEffect } from 'react'

/** The single owner of the body scroll lock, so overlays never fight over document.body.style. */
export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [locked])
}

/** "/" focuses search and "r" refreshes, except while typing or when `enabled` is false. */
export function useShortcuts(enabled: boolean, onRefresh: () => void): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/') {
        e.preventDefault()
        document.getElementById('jb-search')?.focus()
      } else if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        onRefresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onRefresh])
}
