// Runtime app config, injected by jira-intern/local-runner/sync-datajs.mjs as
// window.__JIRA_CONFIG__ (sourced from jira-intern/config.json → "app" section).
// Everything here has a safe default so the app works with no config at all —
// changing config.json + re-running any intern job re-themes the app without a rebuild.

export interface AppRuntimeConfig {
  servePort?: number
  requiredApprovals?: number
  branding?: {
    tagline?: string
    badgeText?: string
    badgeUrl?: string
    badgeTitle?: string
  }
}

const injected: AppRuntimeConfig =
  (typeof window !== 'undefined' && (window as unknown as { __JIRA_CONFIG__?: AppRuntimeConfig }).__JIRA_CONFIG__) || {}

export const APP_CONFIG: Required<Pick<AppRuntimeConfig, 'requiredApprovals'>> & AppRuntimeConfig = {
  ...injected,
  requiredApprovals:
    typeof injected.requiredApprovals === 'number' && injected.requiredApprovals > 0 ? injected.requiredApprovals : 2,
}

// Fallbacks are deliberately generic: whoever clones this sees neutral branding until they
// set `app.branding` in their own config.json (which reaches the built app at runtime via
// window.__JIRA_CONFIG__ — no rebuild needed). Put YOUR name/portfolio there, not here.
export const BRANDING = {
  tagline: injected.branding?.tagline ?? 'Built to dodge JIRA · made with ☕ + a refresh button',
  badgeText: injected.branding?.badgeText ?? '',
  badgeUrl: injected.branding?.badgeUrl ?? '',
  badgeTitle: injected.branding?.badgeTitle ?? '',
}
