# ---- Stage 1: Install Python dependencies ----
FROM python:3.11-slim AS builder

WORKDIR /build

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---- Stage 1b: Build frontend assets (bundled JS + minified CSS) ----
FROM node:22-alpine AS frontend

WORKDIR /build
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
COPY backend/static/ ./backend/static/
RUN npm install --no-audit --no-fund \
    && npm run build

# ---- Stage 2: Production image ----
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Copy pre-installed Python packages
COPY --from=builder /install /usr/local

# curl 用于健康检查；创建非 root 运行用户
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r justsearch \
    && useradd -r -g justsearch -d /app -s /usr/sbin/nologin justsearch

# Copy application code
COPY backend/ /app/backend/
COPY extension/ /app/extension/
COPY run.sh /app/run.sh

# Copy pre-built frontend bundle (dist/ contains hashed assets referenced by main.py)
COPY --from=frontend /build/backend/static/dist /app/backend/static/dist

# Create directories for persistent data (owned by app user)
RUN mkdir -p /app/data \
    && chown -R justsearch:justsearch /app

USER justsearch

EXPOSE 8000

# Healthcheck: lightweight endpoint (auth allows loopback without token)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]

LABEL org.opencontainers.image.title="JustSearch"
LABEL org.opencontainers.image.description="AI-powered deep search assistant (browser-bridge edition)"
LABEL org.opencontainers.image.source="https://github.com/yeahhe365/JustSearch"
LABEL org.opencontainers.image.version="2.4.0"
