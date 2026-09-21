# JIRA-AI-Intern — queue worker + tiny HTTP API.
# Talks to Ollama (compose service or host) or a cloud chat API. Writes reports
# and briefs onto the shared jira-intern volume for the board to render.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    INTERN_DIR=/app/jira-intern \
    PORT=4322
COPY worker.py models.json /app/
COPY prompts /app/prompts
EXPOSE 4322
CMD ["python3", "-u", "/app/worker.py"]
