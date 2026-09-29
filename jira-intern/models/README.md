# Local model files

Drop `.gguf` model files here for **Settings → AI Intern → Local model**. The AI Intern container
registers every file it finds with the JIRA-LLM runtime (Ollama) under a name derived from the file
name — `Qwen3-8B-Q4_K_M.gguf` becomes `qwen3-8b-q4_k_m` — and Settings lists it as ready.

Which models fit your Docker VM, where to download them and how much memory they need is in the
guide: open the board, click **?** in the toolbar, then **AI**. Short version:

| Docker VM memory | Comfortable picks |
| --- | --- |
| 8 GB | Qwen3 4B, Gemma 4 E4B, Llama 3.2 3B |
| 12–16 GB | Qwen 3.5 9B (best all-rounder), Qwen3 8B, Llama 3.1 8B, Qwen2.5-Coder 7B |
| 24 GB+ | Gemma 3/4 12B, Phi-4 14B, gpt-oss 20B |

Use single-file **Q4_K_M** builds from official, Unsloth or bartowski repositories on Hugging Face.
Sharded files (`…-00001-of-00003.gguf`) are not supported — merge them first or pick a smaller quant.

Everything in this folder except this README is git-ignored and never baked into an image.
