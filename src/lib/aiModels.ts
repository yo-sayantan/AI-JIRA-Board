/**
 * Local models the AI Intern can run for PR Readiness Reports, with what they cost in memory.
 *
 * Sizes are for single-file Q4_K_M builds (gpt-oss ships as MXFP4) and `ramGB` is the practical
 * working set: weights + a 16k-token context + runtime overhead. The ceiling for a model inside the
 * JIRA-LLM container is the Docker VM's memory (Docker Desktop → Settings → Resources), not the
 * Mac's — the guide explains how to raise it. Everything here is CPU-only inside Docker (no GPU
 * passthrough on macOS), so speed is "a few tokens a second"; a natively installed Ollama on the
 * same Mac is 5–6× faster and can be used instead via AI_LOCAL_ENDPOINT.
 *
 * `tag` is the name Ollama uses when the model is pulled from its registry (`ollama pull <tag>`);
 * a .gguf dropped into jira-intern/models/ is registered under its file name instead. `hf` points at
 * a Hugging Face page with the GGUF files — download the Q4_K_M file from there.
 */
export interface LocalModel {
  tag: string
  label: string
  params: string
  /** Approximate download size of the Q4_K_M file, GB. */
  fileGB: number
  /** Memory the runtime needs to hold it with a 16k context, GB. */
  ramGB: number
  blurb: string
  hf: string
  /** Best first pick for its memory tier. */
  recommended?: boolean
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    tag: 'qwen3:4b',
    label: 'Qwen3 4B',
    params: '4B · Q4_K_M',
    fileGB: 2.6,
    ramGB: 4.5,
    blurb: 'Fits an 8 GB Docker VM. Solid structured output for its size; the safe choice on a default Docker setup.',
    hf: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF',
    recommended: true,
  },
  {
    tag: 'gemma4:e4b',
    label: 'Gemma 4 E4B',
    params: '4B effective · Q4_K_M',
    fileGB: 3.0,
    ramGB: 5,
    blurb: 'Built for 8 GB machines, with native function calling and JSON output. Google, Apache 2.0.',
    hf: 'https://huggingface.co/models?search=gemma-4%20e4b%20gguf',
  },
  {
    tag: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    params: '3B · Q4_K_M',
    fileGB: 2.0,
    ramGB: 4,
    blurb: 'The smallest sensible option — quick, but keep expectations modest on nuanced diffs.',
    hf: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF',
  },
  {
    tag: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B',
    params: '9B · Q4_K_M',
    fileGB: 5.8,
    ramGB: 8.5,
    blurb: 'The 2026 all-rounder at 16 GB: reasoning close to last year’s 30B models, strong JSON. Needs a 12 GB+ VM.',
    hf: 'https://huggingface.co/models?search=qwen3.5%209b%20gguf',
    recommended: true,
  },
  {
    tag: 'qwen3:8b',
    label: 'Qwen3 8B',
    params: '8B · Q4_K_M',
    fileGB: 5.2,
    ramGB: 7.5,
    blurb: 'The proven dense 8B every runtime supports; a good fallback if 3.5 is not yet in your registry.',
    hf: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF',
  },
  {
    tag: 'qwen2.5-coder:7b',
    label: 'Qwen2.5-Coder 7B',
    params: '7B · Q4_K_M',
    fileGB: 4.7,
    ramGB: 7,
    blurb: 'Code-tuned: the best of the small models at reading a diff and judging what changed.',
    hf: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
  },
  {
    tag: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    params: '8B · Q4_K_M',
    fileGB: 4.9,
    ramGB: 7,
    blurb: 'Meta’s dependable 8B; good tool/JSON discipline, widely mirrored.',
    hf: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
  },
  {
    tag: 'gemma4:12b',
    label: 'Gemma 4 12B',
    params: '12B · Q4_K_M',
    fileGB: 7.5,
    ramGB: 10.5,
    blurb: 'The largest comfortable fit on a 16 GB Mac when the VM gets 12 GB+; native structured output.',
    hf: 'https://huggingface.co/models?search=gemma-4%2012b%20gguf',
  },
  {
    tag: 'gemma3:12b',
    label: 'Gemma 3 12B',
    params: '12B · Q4_K_M',
    fileGB: 7.3,
    ramGB: 10.5,
    blurb: 'Reliable via the OpenAI-compatible route too; the QAT build keeps near-bf16 quality at Q4.',
    hf: 'https://huggingface.co/unsloth/gemma-3-12b-it-GGUF',
  },
  {
    tag: 'phi4:14b',
    label: 'Phi-4 14B',
    params: '14B · Q4_K_M',
    fileGB: 9.1,
    ramGB: 12,
    blurb: 'Microsoft’s reasoning-heavy 14B; the standout scores in its class, wants a 16 GB VM.',
    hf: 'https://huggingface.co/microsoft/phi-4-gguf',
  },
  {
    tag: 'gpt-oss:20b',
    label: 'gpt-oss 20B',
    params: '21B MoE (3.6B active) · MXFP4',
    fileGB: 13,
    ramGB: 16,
    blurb: 'OpenAI’s open-weight reasoner. Fast for its size thanks to MoE, but every expert must sit in memory: 16 GB minimum, 24 GB comfortable.',
    hf: 'https://huggingface.co/models?search=gpt-oss-20b%20gguf',
  },
]

export type Fit = 'fits' | 'tight' | 'no'

/** Does a model fit the memory the runtime actually has? Leaves ~1 GB for the OS inside the VM. */
export function fitFor(m: LocalModel, memGB?: number | null): Fit | null {
  if (!memGB) return null
  if (memGB - m.ramGB >= 1.5) return 'fits'
  if (memGB - m.ramGB >= 0) return 'tight'
  return 'no'
}

/** Ollama names a registered file `<name>:latest`; the picker compares on the bare name. */
export function bareModelName(name: string): string {
  return name.replace(/:latest$/, '')
}

/** Cloud model suggestions per provider — free text is still allowed in the field. */
export const CLOUD_MODEL_SUGGESTIONS: Record<'anthropic' | 'openai', { id: string; hint: string }[]> = {
  anthropic: [
    { id: 'claude-opus-5', hint: 'Best quality — the default' },
    { id: 'claude-sonnet-5', hint: 'Faster and cheaper, still strong' },
    { id: 'claude-haiku-4-5', hint: 'Cheapest; fine for straightforward PRs' },
  ],
  openai: [{ id: '', hint: 'Type the model name your provider expects (any OpenAI-compatible endpoint: OpenAI, Azure, a gateway, a second Ollama…)' }],
}
