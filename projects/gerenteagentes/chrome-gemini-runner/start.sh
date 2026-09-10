#!/bin/bash
set -e

echo "🚀 Iniciando WebAI Provider com VNC..."

# Cria diretório para perfil do Chrome
mkdir -p /tmp/webai-chrome-profile

# Inicia Xvfb (display virtual)
echo "📺 Iniciando Xvfb (display virtual)..."
Xvfb :99 -screen 0 ${RESOLUTION} -ac &
XVFB_PID=$!
sleep 2

# Inicia Fluxbox (window manager leve)
echo "🪟 Iniciando Fluxbox..."
DISPLAY=:99 fluxbox &
FLUXBOX_PID=$!
sleep 1

# Inicia x11vnc (servidor VNC)
echo "🔌 Iniciando x11vnc (porta ${VNC_PORT})..."
if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display :99 -forever -shared -rfbport ${VNC_PORT} -passwd ${VNC_PASSWORD} &
else
    x11vnc -display :99 -forever -shared -rfbport ${VNC_PORT} -nopw &
fi
X11VNC_PID=$!
sleep 2

# Inicia websockify (noVNC - VNC via web)
echo "🌐 Iniciando noVNC (porta ${NOVNC_PORT})..."
# Tenta usar novnc_proxy se existir, senão usa websockify direto
if [ -f /opt/noVNC/utils/novnc_proxy ]; then
    /opt/noVNC/utils/novnc_proxy --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} &
elif [ -f /opt/noVNC/utils/launch.sh ]; then
    /opt/noVNC/utils/launch.sh --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} &
else
    # Fallback: websockify puro (sem interface HTML, só socket)
    echo "   ⚠️ noVNC não disponível, usando websockify puro"
    websockify --web=/usr/share/javascript/novnc ${NOVNC_PORT} localhost:${VNC_PORT} &
fi
NOVNC_PID=$!
sleep 2

echo ""
echo "✅ VNC pronto!"
echo "   🌐 noVNC (via navegador): http://localhost:${NOVNC_PORT}/vnc.html"
echo "   🔌 VNC nativo: localhost:${VNC_PORT}"
echo "   🔑 Senha VNC: ${VNC_PASSWORD:-'(sem senha)'}"
echo ""

# Inicia WebAI Provider
echo "🤖 Iniciando WebAI Provider (porta ${PORT})..."
cd /app
export DISPLAY=:99  # Exporta DISPLAY para o Node.js/Puppeteer
exec node dist/server.js
