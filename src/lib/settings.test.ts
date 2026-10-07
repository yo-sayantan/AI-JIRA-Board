import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from './settings'

describe('parseSettings', () => {
  it('falls back for an invalid aiLevel', () => {
    expect(parseSettings({ aiLevel: 'high' }).aiLevel).toBe(DEFAULT_SETTINGS.aiLevel)
  })
  it('falls back for a model id with shell characters', () => {
    expect(parseSettings({ aiLocalModel: 'bad model;rm' }).aiLocalModel).toBe(DEFAULT_SETTINGS.aiLocalModel)
  })
  it('keeps valid values', () => {
    const s = parseSettings({ aiLevel: 'low', aiBackend: 'cloud', theme: 'light', aiLocalModel: 'llama3.1:8b' })
    expect(s.aiLevel).toBe('low')
    expect(s.aiBackend).toBe('cloud')
    expect(s.theme).toBe('light')
    expect(s.aiLocalModel).toBe('llama3.1:8b')
  })
  it('coerces feature flags to booleans and ignores unknown keys', () => {
    const key = Object.keys(DEFAULT_SETTINGS.features)[0]
    const s = parseSettings({ features: { [key]: 'yes', bogus: true } })
    expect(s.features[key as keyof typeof s.features]).toBe(DEFAULT_SETTINGS.features[key as keyof typeof s.features])
    expect('bogus' in s.features).toBe(false)
    const off = parseSettings({ features: { [key]: false } })
    expect(off.features[key as keyof typeof off.features]).toBe(false)
  })
  it('returns defaults for a non-object', () => {
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
})
