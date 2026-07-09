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

export const BRANDING = {
  tagline: injected.branding?.tagline ?? 'Built to dodge JIRA · made with ☕ + a refresh button',
  badgeText: injected.branding?.badgeText ?? 'Sayantan.dev',
  badgeUrl: injected.branding?.badgeUrl ?? 'https://tinyurl.com/sayantan-myportfolio',
  badgeTitle: injected.branding?.badgeTitle ?? 'Made by Sayantan — sayantan.dev',
}
