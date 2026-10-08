#!/usr/bin/env node
// Splits data.json into one readable file per ticket, for going through them by hand.
//
//   node jira-intern/demo/build.mjs        (or: npm run demo:split)
//
// data.json is the source of truth — the board loads that. tickets/ is a generated mirror:
// edit data.json, re-run this, and the folder matches again. Zero dependencies.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'tickets')

const dump = JSON.parse(await readFile(join(HERE, 'data.json'), 'utf8'))
await mkdir(OUT, { recursive: true })

// Drop files for tickets that no longer exist, so the folder never shows a stale key.
const keep = new Set()
const write = async (name, body) => {
  keep.add(name)
  await writeFile(join(OUT, name), JSON.stringify(body, null, 2) + '\n')
}

for (const t of dump.tickets ?? []) await write(`${t.key}.json`, t)
for (const c of dump.completed ?? []) await write(`completed-${c.key}.json`, c)
for (const r of dump.raised ?? []) await write(`raised-${r.key}.json`, r)

let removed = 0
for (const f of await readdir(OUT)) {
  if (f.endsWith('.json') && !keep.has(f)) {
    await unlink(join(OUT, f))
    removed++
  }
}

const sub = (dump.tickets ?? []).reduce((n, t) => n + (t.subtasks?.length ?? 0), 0)
console.log(`tickets/: ${keep.size} files written${removed ? `, ${removed} stale removed` : ''} ` + `(${dump.tickets?.length ?? 0} board tickets with ${sub} sub-tasks, ${dump.completed?.length ?? 0} completed, ${dump.raised?.length ?? 0} raised)`)
