// Regenerate data.js from data.json, ATOMICALLY.
// data.js is ~850KB and the board reads it live (window.__JIRA_DATA__) off file://, so a
// truncated mid-write leaves the board blank. We write a temp file in the same dir and
// renameSync() over the target (atomic on one filesystem). Shared by all runner scripts so
// the regeneration logic lives in exactly one place.
//
//   node sync-datajs.mjs <intern-dir>
//
// Exit 0 on success, non-zero (with a message on stderr) if data.json is missing/invalid.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

const dir = process.argv[2]
if (!dir) {
  process.stderr.write('usage: node sync-datajs.mjs <intern-dir>\n')
  process.exit(2)
}
const src = join(dir, 'data.json')
const dst = join(dir, 'data.js')
const tmp = join(dir, '.data.js.swap')
const cfgPath = join(dir, 'config.json')
try {
  const obj = JSON.parse(readFileSync(src, 'utf8'))
  // Also expose the app-facing config section (branding, requiredApprovals, …) so the
  // built app picks it up at runtime off file:// — portability without a rebuild.
  let appCfg = null
  try {
    appCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))?.app ?? null
  } catch {}
  const js =
    '// AUTO-GENERATED from data.json. Do not edit by hand.\n' +
    'window.__JIRA_DATA__ = ' +
    JSON.stringify(obj, null, 2) +
    ';\n' +
    (appCfg ? 'window.__JIRA_CONFIG__ = ' + JSON.stringify(appCfg, null, 2) + ';\n' : '')
  writeFileSync(tmp, js)
  renameSync(tmp, dst)
} catch (e) {
  try {
    rmSync(tmp, { force: true })
  } catch {}
  process.stderr.write('sync-datajs: ' + (e && e.message ? e.message : String(e)) + '\n')
  process.exit(1)
}
