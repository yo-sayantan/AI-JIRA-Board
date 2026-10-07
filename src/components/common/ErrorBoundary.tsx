import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Pill } from './ui'

/**
 * Last line of defence: one bad field in a dump (a malformed date, an entity the decoder cannot
 * handle, a report with no tabs) must cost the user one overlay, not the whole board. The fallback
 * is deliberately small — a label, the message, and a way out — and is styled with the board's own
 * tokens so it never looks foreign.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    /** What the boundary protects, for the message — "this ticket", "the report", "Settings". */
    label?: string
    /** Offered as the Close button: the caller dismisses the overlay and the boundary resets. */
    onClose?: () => void
    /** Draw the fallback as a fixed layer, so a crash inside a portalled overlay is still visible. */
    overlay?: boolean
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[jira-board] render failed', error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
    this.props.onClose?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const { label, onClose, overlay } = this.props
    const button =
      'inline-flex h-8 items-center rounded-lg border px-3 text-[12px] font-bold transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)]'
    const card = (
      <div
        role="alert"
        className="flex w-full max-w-md flex-col gap-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface-solid)] px-5 py-4 text-left shadow-2xl card-shadow"
      >
        <div className="flex items-center gap-2">
          <Pill color="#ef4444" filled>
            Error
          </Pill>
          <span className="text-[14px] font-extrabold text-[var(--ink)]">Something went wrong</span>
        </div>
        <p className="text-[12.5px] leading-relaxed text-[var(--ink-soft)]">
          {label ? `${label[0].toUpperCase()}${label.slice(1)} could not be shown.` : 'This part of the board could not be shown.'}{' '}
          The rest keeps working; the details are in the browser console.
        </p>
        {error.message && <code className="truncate rounded-md bg-[var(--surface-2)] px-2 py-1 font-mono text-[10.5px] text-[var(--muted)]">{error.message}</code>}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button type="button" onClick={this.reset} className={`${button} border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--ink-soft)]`}>
            {onClose ? 'Close' : 'Try again'}
          </button>
          <button type="button" onClick={() => location.reload()} className={`${button} border-transparent text-white`} style={{ background: 'linear-gradient(135deg, #7c5cff, #2684ff)' }}>
            Reload the board
          </button>
        </div>
      </div>
    )
    return overlay ? (
      <div className="fixed inset-0 z-[200] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">{card}</div>
    ) : (
      <div className="grid min-h-[40vh] w-full place-items-center p-6">{card}</div>
    )
  }
}
