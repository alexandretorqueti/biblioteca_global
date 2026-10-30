#!/usr/bin/env bash
# Smoke test das funções de dump de logs (melhoria #5) — docker fake.
set -euo pipefail

SCRIPT="${1:?uso: smoke-log-dump.sh <caminho-para-deploy-blue-green.sh>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- docker fake ---
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) exit 0 ;;
  logs)
    # último arg = container
    for last in "$@"; do :; done
    echo "2026-10-30T12:00:00Z linha 1 do log de $last"
    echo "2026-10-30T12:00:01Z [QueueConsumer] exemplo" >&2
    exit 0 ;;
  ps)
    # ps -aq --filter label=com.docker.compose.project=biblioteca-blue
    for a in "$@"; do
      case "$a" in
        *biblioteca-blue*) printf 'biblioteca-blue-api-1\nbiblioteca-blue-web-1\n'; exit 0 ;;
        *vazio*) exit 0 ;;
      esac
    done
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH"

# --- extrai e carrega as funções do script real (do bloco LOG_DUMP_ROOT ao fim de dump_project_logs) ---
eval "$(awk '/^LOG_DUMP_ROOT=/{f=1} f{print} /^dump_project_logs\(\)/{g=1} g&&/^}/{exit}' "$SCRIPT")"

export LOG_DUMP_ROOT="$TMP/logs"
export BLUE_GREEN_LOG_KEEP=3
LOG_DUMP_KEEP=3
DEPLOY_BATCH_ID="batch-123"
active=green; target=blue

# git fake (repo tmp não é git)
git() { echo "fakecommit"; }; export -f git 2>/dev/null || true

# 1) dump de projeto com containers via label
dump_project_logs "biblioteca-blue-removido" "biblioteca-blue"
dir1="$(ls -1dt "$LOG_DUMP_ROOT"/*-biblioteca-blue-removido | head -1)"
[ -f "$dir1/biblioteca-blue-api-1.log.gz" ] || { echo "FALHA: log da api não gzippado"; exit 1; }
[ -f "$dir1/biblioteca-blue-web-1.log.gz" ] || { echo "FALHA: log da web ausente"; exit 1; }
grep -q "deploy_batch_id=batch-123" "$dir1/dump-info.txt" || { echo "FALHA: dump-info sem batch"; exit 1; }
gzip -t "$dir1/biblioteca-blue-api-1.log.gz" && zcat "$dir1/biblioteca-blue-api-1.log.gz" | grep -q "linha 1 do log" || { echo "FALHA: conteúdo do log"; exit 1; }
echo "OK: dump com label + gzip + dump-info"

# 2) fallback sem label → nomes explícitos api-1/web-1
dump_project_logs "biblioteca-vazio-removido" "biblioteca-vazio"
dir2="$(ls -1dt "$LOG_DUMP_ROOT"/*-biblioteca-vazio-removido | head -1)"
[ -f "$dir2/biblioteca-vazio-api-1.log.gz" ] || { echo "FALHA: fallback api-1"; exit 1; }
echo "OK: fallback nomes explícitos"

# 3) dump_container_logs direto (caso legacy)
mkdir -p "$LOG_DUMP_ROOT/manual-legacy"
dump_container_logs "$LOG_DUMP_ROOT/manual-legacy" biblioteca-global-api biblioteca-global-web
[ -f "$LOG_DUMP_ROOT/manual-legacy/biblioteca-global-api.log.gz" ] || { echo "FALHA: legacy dump"; exit 1; }
echo "OK: dump_container_logs legacy"

# 4) retenção: cria dumps até exceder KEEP=3 → mais antigos removidos
for i in 1 2 3 4 5; do
  mkdir -p "$LOG_DUMP_ROOT/2026010${i}T000000Z-fake-${i}"
  sleep 0.1
done
prune_log_dumps
count="$(ls -1d "$LOG_DUMP_ROOT"/*/ | wc -l)"
[ "$count" -le 3 ] || { echo "FALHA: retenção não aplicada (count=$count)"; exit 1; }
[ ! -d "$LOG_DUMP_ROOT/20260101T000000Z-fake-1" ] || { echo "FALHA: dump mais antigo sobreviveu"; exit 1; }
[ -d "$LOG_DUMP_ROOT/20260105T000000Z-fake-5" ] || { echo "FALHA: dump mais novo removido"; exit 1; }
echo "OK: retenção (keep=3)"

echo "SMOKE_OK"
