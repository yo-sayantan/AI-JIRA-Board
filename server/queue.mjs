import { spawn } from 'node:child_process'
import { ROOT } from './config.mjs'

/**
 * Spawn a child and resolve with its exit code. A signal kill or spawn error counts as 1, so the
 * board never reports a killed job as a success. `onSpawn` receives the child for cancellation.
 */
export function runProcess(cmd, args, { onSpawn, ...opts } = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', ...opts })
      onSpawn?.(child)
      child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
      child.on('error', () => resolve(1))
    } catch {
      resolve(1)
    }
  })
}

/**
 * FIFO of ticket keys run one at a time. Jobs that share data.json must never overlap, so the
 * queue waits (without dropping anything) while `isBlocked()` says another writer is busy.
 * The last exit code per key is kept so the board can tell "failed" from "up to date".
 */
export class KeyQueue {
  #waiting = []
  #timer = null

  constructor({ run, isBlocked, retryMs = 2000 }) {
    this.run = run
    this.isBlocked = isBlocked
    this.retryMs = retryMs
    this.active = null
    this.exits = new Map()
  }

  /** Active key first, then waiting keys in start order. */
  get pending() {
    return this.active ? [this.active, ...this.#waiting] : [...this.#waiting]
  }

  get size() {
    return this.#waiting.length + (this.active ? 1 : 0)
  }

  has(key) {
    return this.active === key || this.#waiting.includes(key)
  }

  /** Queue a key. Returns false when it is already active or waiting. */
  add(key) {
    if (this.has(key)) return false
    this.exits.delete(key)
    this.#waiting.push(key)
    void this.pump()
    return true
  }

  clear() {
    this.#waiting.length = 0
  }

  async pump() {
    clearTimeout(this.#timer)
    this.#timer = null
    if (this.active || this.#waiting.length === 0) return
    if (await this.isBlocked()) {
      this.#timer = setTimeout(() => void this.pump(), this.retryMs)
      return
    }
    if (this.active || this.#waiting.length === 0) return

    const key = this.#waiting.shift()
    this.active = key
    let code = 1
    try {
      code = await this.run(key)
    } catch {
      code = 1
    }
    this.active = null
    this.exits.set(key, code)
    void this.pump()
  }
}

/**
 * Spawn a child and resolve with its stdout (trimmed) plus exit code. For verdict-style
 * scripts that print one JSON line; stderr is left to the terminal.
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], ...opts })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.on('exit', (code, signal) => resolve({ out: out.trim(), code: signal ? 1 : (code ?? 1) }))
      child.on('error', () => resolve({ out, code: 1 }))
    } catch {
      resolve({ out: '', code: 1 })
    }
  })
}
