import { useCallback, useMemo, useRef, useState } from 'react'
import { injectedDump, loadArchivedKeys, loadData, persistArchivedKeys } from '../data'
import { getDataDump } from '../lib/runner'

/**
 * The dump the board renders, plus the keys the user moved to Completed by hand. Served mode swaps
 * in a fresh data.json in place; file:// has no server to ask, so it reloads the page for data.js.
 */
export function useBoardData(served: boolean) {
  const [raw, setRaw] = useState(injectedDump)
  const [archived, setArchived] = useState(() => loadArchivedKeys(injectedDump()))
  const view = useMemo(() => loadData(raw, archived), [raw, archived])
  const latestReload = useRef(0)

  const reload = useCallback(async () => {
    // Jobs finishing close together each reload; only the newest fetch may land, or a slow
    // older response would put stale data back on the board.
    const seq = ++latestReload.current
    const next = served ? await getDataDump() : null
    if (seq !== latestReload.current) return
    if (next) setRaw(next)
    else location.reload()
  }, [served])

  const updateArchived = useCallback((update: (keys: Set<string>) => void) => {
    setArchived((prev) => {
      const next = new Set(prev)
      update(next)
      persistArchivedKeys(next)
      return next
    })
  }, [])
  const archive = useCallback((key: string) => updateArchived((keys) => keys.add(key)), [updateArchived])
  const restoreArchived = useCallback(() => updateArchived((keys) => keys.clear()), [updateArchived])

  return { ...view, reload, archive, restoreArchived }
}
