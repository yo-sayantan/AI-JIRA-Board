# Local AI models

This directory is the AI-Ollama container's store (`/root/.ollama`) **and** the switch that lets it
run: the container starts only when Settings → *AI-Ollama container* is on **and** something here
is a model.

Two ways to put a model here:

1. **Pull from Settings** — pick a model in Settings → AI → Local AI and click its download icon.
   Ollama writes it under `models/manifests/` and `models/blobs/` in this directory.
2. **Drop a `.gguf` file** you downloaded by hand (links are in `ai-intern/models.json`), then
   register it with Ollama once the container is up:

   ```bash
   printf 'FROM /root/.ollama/<file>.gguf\n' > jira-intern/models/Modelfile
   docker exec AI-Ollama ollama create <tag> -f /root/.ollama/Modelfile
   ```

   Use the catalog's exact tag so the Settings list recognises it.

Everything here except this README is git-ignored.
