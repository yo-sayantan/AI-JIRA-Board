import { EyeOffIcon } from '../common/Icons'

export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="grid min-h-[34vh] place-items-center rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] text-center">
      <div>
        <div className="mb-2 text-3xl">🔍</div>
        <p className="text-[14px] font-semibold text-[var(--ink)]">No tickets match “{query}”.</p>
        <button onClick={onClear} className="mt-2 text-[12.5px] text-[#8b9cff] hover:underline">
          Clear search
        </button>
      </div>
    </div>
  )
}

/** Tickets the user moved to Completed by hand, with a one-click undo. */
export function ArchivedUndo({ keys, onUndo }: { keys: string[]; onUndo: () => void }) {
  return (
    <div className="mt-2 flex justify-end">
      <button
        onClick={onUndo}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
        title={`You moved ${keys.join(', ')} to Completed — undo to bring ${keys.length === 1 ? 'it' : 'them'} back onto the board`}
      >
        <EyeOffIcon size={13} /> {keys.length} moved to Completed · Undo
      </button>
    </div>
  )
}
