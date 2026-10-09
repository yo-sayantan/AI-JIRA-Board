// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applySettings, loadSettings } from './settings'
import { motionEnabled, setMotionEnabled } from './motionPolicy'

afterEach(() => {
  setMotionEnabled(true)
  document.documentElement.className = ''
})

describe('Motion & animations switch', () => {
  it('turns off BOTH halves: the CSS class and framer-motion\'s JavaScript animations', () => {
    const s = loadSettings()
    applySettings({ ...s, features: { ...s.features, animations: false } })
    expect(document.documentElement.classList.contains('jb-no-anim')).toBe(true)
    // The class alone only tames CSS; motion's JS-driven animations need the master switch.
    expect(motionEnabled()).toBe(false)
  })

  it('turns both back on without a reload', () => {
    const s = loadSettings()
    applySettings({ ...s, features: { ...s.features, animations: false } })
    applySettings({ ...s, features: { ...s.features, animations: true } })
    expect(document.documentElement.classList.contains('jb-no-anim')).toBe(false)
    expect(motionEnabled()).toBe(true)
  })

  it('is on by default', () => {
    applySettings(loadSettings())
    expect(motionEnabled()).toBe(true)
  })
})
