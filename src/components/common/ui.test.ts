// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isSafeUrl, safeHref, sanitizeHtml } from './ui'

describe('safeHref', () => {
  it('rejects javascript: and accepts https', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref(' java\tscript:alert(1)')).toBeUndefined()
    expect(safeHref('https://x')).toBe('https://x')
    expect(safeHref(null)).toBeUndefined()
    expect(isSafeUrl('data:text/html,hi')).toBe(false)
  })
})

describe('sanitizeHtml', () => {
  it('strips scripts and event handlers, keeps safe markup', () => {
    const out = sanitizeHtml('<b>bold</b><script>alert(1)</script><img src=x onerror="alert(1)"><a href="https://e.com">l</a>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).toContain('<b>bold</b>')
    expect(out).toContain('href="https://e.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
  it('drops unsafe hrefs', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  })
})
