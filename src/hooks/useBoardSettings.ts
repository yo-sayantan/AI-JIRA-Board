import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getServerSettings, saveServerSettings, type OllamaAction } from '../lib/runner'
import {
  applySettings,
  loadSettings,
  mergeServerSettings,
  resolveDark,
  saveSettings,
  serverSettingsOf,
  type ServerSettings,
  type Settings,
} from '../lib/settings'

/**
 * Board settings: persisted locally, applied to <html>, and in served mode synced with the server
 * so scheduled and background jobs honour the same AI and cadence choices.
 */
export function useBoardSettings(served: boolean, now: number, onOllama?: (action: OllamaAction) => void) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  // `ready` opens the Settings panel once the first GET settles, success or not. `synced` is true
  // only after a GET succeeded: until then a POST would overwrite the server with this browser's guess.
  const [ready, setReady] = useState(!served)
  const [synced, setSynced] = useState(false)
  const [saveFailed, setSaveFailed] = useState(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const lastSent = useRef<string | null>(null)
  const onOllamaRef = useRef(onOllama)
  onOllamaRef.current = onOllama
  const dark = useMemo(() => resolveDark(settings, new Date(now)), [settings, now])

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => applySettings(settings, new Date(now)), [settings, now])

  useEffect(() => {
    if (!served) return
    void getServerSettings().then((saved) => {
      if (saved) {
        lastSent.current = JSON.stringify(serverSettingsOf(mergeServerSettings(settingsRef.current, saved)))
        setSettings((current) => mergeServerSettings(current, saved))
        setSynced(true)
      }
      setReady(true)
    })
  }, [served])

  const serverJson = JSON.stringify(serverSettingsOf(settings))
  useEffect(() => {
    if (!served || !synced || lastSent.current === serverJson) return
    lastSent.current = serverJson
    void saveServerSettings(JSON.parse(serverJson) as ServerSettings).then((result) => {
      if (result) {
        if (result !== 'unchanged') onOllamaRef.current?.(result)
        return
      }
      lastSent.current = null
      setSaveFailed((n) => n + 1)
    })
  }, [served, synced, serverJson])

  // Flipping the theme from the header pins it; auto or a schedule would override the click.
  const toggleTheme = useCallback(() => {
    setSettings((s) => ({ ...s, themeMode: 'fixed', theme: resolveDark(s) ? 'light' : 'dark' }))
  }, [])

  return { settings, setSettings, ready, dark, toggleTheme, saveFailed }
}
