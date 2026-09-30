import { useCallback, useEffect, useMemo, useState } from 'react'
import { getServerSettings, saveServerSettings } from '../lib/runner'
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
export function useBoardSettings(served: boolean, now: number) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [ready, setReady] = useState(!served)
  const dark = useMemo(() => resolveDark(settings, new Date(now)), [settings, now])

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => applySettings(settings, new Date(now)), [settings, now])

  useEffect(() => {
    if (!served) return
    void getServerSettings().then((saved) => {
      if (saved) setSettings((current) => mergeServerSettings(current, saved))
      setReady(true)
    })
  }, [served])

  const serverJson = JSON.stringify(serverSettingsOf(settings))
  useEffect(() => {
    if (served && ready) void saveServerSettings(JSON.parse(serverJson) as ServerSettings)
  }, [served, ready, serverJson])

  // Flipping the theme from the header pins it; auto or a schedule would override the click.
  const toggleTheme = useCallback(() => {
    setSettings((s) => ({ ...s, themeMode: 'fixed', theme: resolveDark(s) ? 'light' : 'dark' }))
  }, [])

  return { settings, setSettings, ready, dark, toggleTheme }
}
