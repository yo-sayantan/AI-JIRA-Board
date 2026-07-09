import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The board reads its data from a *separate*, externally-loaded file so the
// `jira-intern` runner can refresh the data WITHOUT ever rebuilding the app.
// jira-intern (jira-board/jira-intern/) writes data.js -> window.__JIRA_DATA__ = {...}
// From the built file at  jira-board/dist/index.html  the relative path is
// ../jira-intern/data.js  ->  jira-board/jira-intern/data.js
// We inject it as a raw <script> so Vite/singlefile never tries to bundle/inline it.
const DATA_SCRIPT_SRC = '../jira-intern/data.js'

function injectDataScript(): Plugin {
  return {
    name: 'inject-external-data-script',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: DATA_SCRIPT_SRC }, injectTo: 'head-prepend' }]
    },
  }
}

// CRITICAL for file:// — browsers refuse to execute <script type="module"> when the
// page is opened from disk (origin "null"). Our bundle has no import/export/import.meta
// (verified), so we downgrade the inlined module script to a classic script after the
// single-file build. This makes dist/index.html run on a plain double-click.
function classicScriptForFileProtocol(): Plugin {
  return {
    name: 'classic-script-for-file-protocol',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist/index.html')
      let html = readFileSync(out, 'utf8')
      // Only rewrite actual <script …> OPENING tags, and match type="module" regardless of where
      // it sits among the attributes (Vite could emit crossorigin/nonce before type, or reorder).
      // We strip just the type="module" + crossorigin attributes, preserving src and the rest,
      // rather than blowing away the whole tag — so this survives Vite output changes.
      let hits = 0
      html = html.replace(/<script\b[^>]*>/gi, (tag) => {
        if (!/\btype\s*=\s*["']module["']/i.test(tag)) return tag
        hits++
        return tag
          .replace(/\s+type\s*=\s*["']module["']/i, '')
          .replace(/\s+crossorigin(\s*=\s*("[^"]*"|'[^']*'|\S+))?/i, '')
      })
      if (hits === 0) {
        this.warn(
          'classic-script-for-file-protocol: no <script type="module"> found to downgrade — ' +
            'dist/index.html may not run from file:// (Vite output format may have changed).',
        )
      }
      writeFileSync(out, html)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), viteSingleFile(), injectDataScript(), classicScriptForFileProtocol()],
  build: {
    target: 'es2019',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
})
