FROM node:22-slim

# Instala dependências do Chrome/Chromium + VNC
RUN apt-get update && apt-get install -y \
    # Chromium do sistema (fallback)
    chromium \
    # Dependências do Chrome que o Puppeteer baixa
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    # Fontes
    fonts-liberation \
    fonts-noto-color-emoji \
    # Utilitários
    xdg-utils \
    # VNC e display virtual
    xvfb \
    x11vnc \
    fluxbox \
    # noVNC (VNC via web)
    python3 \
    python3-numpy \
    websockify \
    # wget para baixar noVNC
    wget \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Instala noVNC (cliente VNC via web) - usa websockify do apt
RUN mkdir -p /opt/noVNC && \
    cd /opt/noVNC && \
    (wget --no-check-certificate -q https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz -O novnc.tar.gz 2>/dev/null || \
     curl -sLk https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz -o novnc.tar.gz 2>/dev/null || \
     echo "Download failed, will use websockify standalone") && \
    if [ -f novnc.tar.gz ] && [ -s novnc.tar.gz ]; then \
      tar -xzf novnc.tar.gz --strip-components=1 && \
      rm -f novnc.tar.gz && \
      ln -sf /opt/noVNC/vnc_lite.html /opt/noVNC/index.html; \
    else \
      echo "noVNC download failed, using websockify only"; \
    fi

WORKDIR /app

# Copia package files
COPY package*.json ./

# Instala dependências
RUN npm ci --only=production

# Copia código compilado
COPY dist ./dist

# Copia script de inicialização
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Variáveis de ambiente
ENV PORT=3100
ENV HEADLESS=false
ENV DEBUG_PORT=9222
ENV TASK_TIMEOUT_MS=1800000
ENV COMMAND_TIMEOUT_MS=60000
ENV POLL_INTERVAL_MS=10000
# VNC
ENV DISPLAY=:99
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV VNC_PASSWORD=global
ENV RESOLUTION=1280x1024x24

# Expõe portas
EXPOSE 3100 6080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

# Inicia tudo (Xvfb + VNC + noVNC + WebAI Provider)
CMD ["/start.sh"]
