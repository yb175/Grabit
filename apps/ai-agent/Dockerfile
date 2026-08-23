# Grabit AI Agent — container image.
# Runs the FastAPI service that classifies payment failures and generates
# recovery message copy using the Agno agent framework.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
