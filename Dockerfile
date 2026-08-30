FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install dependencies first for better Railway/Docker layer caching.
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip && \
    python -m pip install --no-cache-dir -r /app/requirements.txt

# Copy only files required at runtime. Railway environment variables are
# provided through the service Variables panel, so no .env file is needed.
COPY bot.py /app/bot.py

# SQLite data directory (attach a Railway Volume to /app/data if persistence is needed).
RUN mkdir -p /app/data

CMD ["python", "-u", "/app/bot.py"]
