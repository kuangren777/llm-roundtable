FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/backend/requirements.txt

COPY backend /app/backend
COPY config /app/config

RUN mkdir -p /app/backend/uploads /data

EXPOSE 8000

CMD ["sh", "-c", "uvicorn backend.app.main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8000}"]
