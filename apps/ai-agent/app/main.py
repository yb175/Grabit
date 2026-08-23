"""
Grabit AI Agent — FastAPI entrypoint.

Grabit is an AI-powered Payment Revenue Recovery system. This Python service
is the diagnosis brain: the API and workers (TypeScript) call it over HTTP to
classify payment failures and generate recovery message copy.

Eventually exposes:
  POST /diagnose   — classify a failure (Hard / Soft / Autopay Failed / Autopay Cancelled) + recommend action
  POST /message    — generate personalized WhatsApp recovery copy (GenZ/Hinglish variants)
  POST /explain    — human-readable explanation of why a payment failed
  GET  /health     — liveness probe

Chunk 1: skeleton with /health only.
"""
from fastapi import FastAPI

app = FastAPI(title="grabit-ai-agent")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "grabit-ai-agent"}
