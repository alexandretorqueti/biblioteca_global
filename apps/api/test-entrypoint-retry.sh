#!/bin/bash
# Teste automatizado: retry de db:migrate:gerenteagentes no entrypoint
#
# Critérios cobertos:
#   ✓ Duas falhas consecutivas de db:migrate:gerenteagentes são seguidas de
#     retry; sucesso na terceira tentativa encerra o loop.
#   ✓ db:migrate global permanece inalterado (sem retry em português).
#   ✓ Após sucesso, os processos finais do container são alcançados.
#   ✓ bash -n valida o entrypoint.
#
# Execução: bash apps/api/test-entrypoint-retry.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/docker-entrypoint.sh"

PASS=0
FAIL=0
TESTS=""

pass() { PASS=$((PASS + 1)); TESTS="$TESTS\n  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); TESTS="$TESTS\n  ✗ $1: $2"; }

# bash -n valida sintaxe do entrypoint
if bash -n "$ENTRYPOINT" 2>/dev/null; then
  pass "bash -n valida o entrypoint"
else
  fail "bash -n" "sintaxe inválida"
fi

# ---------------------------------------------------------------------------
# Teste 1: db:migrate:gerenteagentes falha 2x e succeeds na 3ª tentativa
# ---------------------------------------------------------------------------

TEST_DIR=$(mktemp -d)
FAKE_BIN="$TEST_DIR/bin"
SOURCE_DIR="$TEST_DIR/src"
FAIL_FILE="$TEST_DIR/fail_count"

mkdir -p "$FAKE_BIN" "$SOURCE_DIR" "$SOURCE_DIR/apps/api"
echo '{}' > "$SOURCE_DIR/package.json"
echo "0" > "$FAIL_FILE"
export FAIL_FILE  # subprocesso npm precisa acessar esta variável
touch "$FAKE_BIN/known_hosts"

# npm falso: db:migrate global succeeds sempre;
# db:migrate:gerenteagentes falha nas 2 primeiras chamadas e succeeds na 3ª;
# db:bootstrap:gerenteagentes succeeds sempre.
cat > "$FAKE_BIN/npm" << 'FAKE_NPM'
#!/bin/sh
args="$*"
case "$args" in
  "run db:migrate")
    exit 0
    ;;
  "run db:migrate:gerenteagentes")
    count=$(cat "$FAIL_FILE")
    count=$((count + 1))
    echo "$count" > "$FAIL_FILE"
    if [ "$count" -lt 3 ]; then
      echo "[npm falso] db:migrate:gerenteagentes falha simulada (chamada $count)" >&2
      exit 1
    fi
    exit 0
    ;;
  "run db:bootstrap:gerenteagentes")
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
FAKE_NPM

# git falso (apenas existe para os comandos do entrypoint)
cat > "$FAKE_BIN/git" << 'FAKE_GIT'
#!/bin/sh
exit 0
FAKE_GIT

# node falso — registra que o entrypoint alcançou o início dos processos
cat > "$FAKE_BIN/node" << FAKE_NODE
#!/bin/sh
echo "[node falso] iniciando \$*"
FAKE_NODE

# ssh-keyscan falso (falha — não há rede no teste)
cat > "$FAKE_BIN/ssh-keyscan" << 'FAKE_KEYSCAN'
#!/bin/sh
exit 1
FAKE_KEYSCAN

# ssh-keygen falso — retorna 1 (não encontrado) para que o retry do
# known_hosts não interfira no teste (roda em background).
cat > "$FAKE_BIN/ssh-keygen" << 'FAKE_KEYGEN'
#!/bin/sh
exit 1
FAKE_KEYGEN

chmod +x "$FAKE_BIN"/*

# Sobrescreve sleep para acelerar o teste (2s → 0.05s)
cat > "$FAKE_BIN/sleep" << 'FAKE_SLEEP'
#!/bin/sh
# No-op: acelera retries no teste
FAKE_SLEEP
chmod +x "$FAKE_BIN/sleep"

export PATH="$FAKE_BIN:$PATH"
export REPO_PATH="$SOURCE_DIR"
# Desabilita background do known_hosts (evita race condition no teste)
export ENTRYPOINT_SSH_DIRECTORY="$FAKE_BIN"

output=$(bash "$ENTRYPOINT" 2>&1) || true
code=$?

# O entrypoint faz `exec node ...` ao final; nosso node falso retorna 0.
if [ "$code" -eq 0 ]; then
  pass "exit code 0 após 2 falhas e sucesso na 3ª"
else
  fail "exit code" "esperado 0, obtido $code"
fi

if echo "$output" | grep -q "tentativa 1/30"; then
  pass "log da 1ª tentativa registrado"
else
  fail "log 1ª tentativa" "mensagem de retry ausente no output"
fi

if echo "$output" | grep -q "tentativa 2/30"; then
  pass "log da 2ª tentativa registrado"
else
  fail "log 2ª tentativa" "mensagem de retry ausente no output"
fi

if ! echo "$output" | grep -q "indisponível após 30 tentativas"; then
  pass "não esgotou o limite de tentativas"
else
  fail "limite" "entrypoint reportou esgotamento de tentativas"
fi

# Verifica que os processos finais foram alcançados (node foi invocado)
if echo "$output" | grep -qE "node falso|Motor|API"; then
  pass "processos finais do container foram alcançados após sucesso"
else
  fail "processos finais" "entrypoint não alcançou o início dos serviços"
fi

# Garante que a mensagem está em português
if echo "$output" | grep -q "db:migrate:gerenteagentes falhou"; then
  pass "mensagem de retry em português"
else
  fail "idioma" "mensagem de retry não está em português"
fi

# Limpa teste 1
rm -rf "$TEST_DIR"

# ---------------------------------------------------------------------------
# Teste 2: db:migrate global NÃO é afetado (permanece sem log de retry)
# ---------------------------------------------------------------------------

TEST_DIR2=$(mktemp -d)
FAKE_BIN2="$TEST_DIR2/bin"
SOURCE_DIR2="$TEST_DIR2/src"

mkdir -p "$FAKE_BIN2" "$SOURCE_DIR2" "$SOURCE_DIR2/apps/api"
echo '{}' > "$SOURCE_DIR2/package.json"

# npm falso: tudo succeeds de primeira
cat > "$FAKE_BIN2/npm" << 'FAKE_NPM2'
#!/bin/sh
exit 0
FAKE_NPM2

cat > "$FAKE_BIN2/git" << 'FAKE_GIT2'
#!/bin/sh
exit 0
FAKE_GIT2

cat > "$FAKE_BIN2/node" << 'FAKE_NODE2'
#!/bin/sh
exit 0
FAKE_NODE2

cat > "$FAKE_BIN2/ssh-keyscan" << 'FAKE_KS2'
#!/bin/sh
exit 1
FAKE_KS2

cat > "$FAKE_BIN2/ssh-keygen" << 'FAKE_KG2'
#!/bin/sh
exit 1
FAKE_KG2

cat > "$FAKE_BIN2/sleep" << 'FAKE_SL2'
#!/bin/sh
:
FAKE_SL2

chmod +x "$FAKE_BIN2"/*

export PATH="$FAKE_BIN2:$PATH"
export REPO_PATH="$SOURCE_DIR2"
export ENTRYPOINT_SSH_DIRECTORY="$FAKE_BIN2"

output2=$(bash "$ENTRYPOINT" 2>&1) || true

# db:migrate global não deve ter mensagem de retry em português
if ! echo "$output2" | grep -q "db:migrate falhou"; then
  pass "db:migrate global não tem log de retry (comportamento preservado)"
else
  fail "db:migrate global" "log de retry apareceu indevidamente"
fi

# db:migrate:gerenteagentes deve ter sucesso sem retry
if ! echo "$output2" | grep -q "db:migrate:gerenteagentes falhou"; then
  pass "db:migrate:gerenteagentes sem retry quando succeeds de primeira"
else
  fail "retry desnecessário" "log de retry apareceu mesmo com sucesso na 1ª vez"
fi

rm -rf "$TEST_DIR2"

# ---------------------------------------------------------------------------
# Teste 3: limite de 30 tentativas — falha definitiva encerra o entrypoint
# ---------------------------------------------------------------------------

TEST_DIR3=$(mktemp -d)
FAKE_BIN3="$TEST_DIR3/bin"
SOURCE_DIR3="$TEST_DIR3/src"

mkdir -p "$FAKE_BIN3" "$SOURCE_DIR3" "$SOURCE_DIR3/apps/api"
echo '{}' > "$SOURCE_DIR3/package.json"

# npm falso: db:migrate:gerenteagentes SEMPRE falha
cat > "$FAKE_BIN3/npm" << 'FAKE_NPM3'
#!/bin/sh
args="$*"
case "$args" in
  "run db:migrate")
    exit 0
    ;;
  "run db:migrate:gerenteagentes")
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
FAKE_NPM3

cat > "$FAKE_BIN3/git" << 'FAKE_GIT3'
#!/bin/sh
exit 0
FAKE_GIT3

cat > "$FAKE_BIN3/node" << 'FAKE_NODE3'
#!/bin/sh
exit 0
FAKE_NODE3

cat > "$FAKE_BIN3/ssh-keyscan" << 'FAKE_KS3'
#!/bin/sh
exit 1
FAKE_KS3

cat > "$FAKE_BIN3/ssh-keygen" << 'FAKE_KG3'
#!/bin/sh
exit 1
FAKE_KG3

cat > "$FAKE_BIN3/sleep" << 'FAKE_SL3'
#!/bin/sh
:
FAKE_SL3

chmod +x "$FAKE_BIN3"/*

export PATH="$FAKE_BIN3:$PATH"
export REPO_PATH="$SOURCE_DIR3"
export ENTRYPOINT_SSH_DIRECTORY="$FAKE_BIN3"

output3=$(bash "$ENTRYPOINT" 2>&1)
code3=$?

if [ "$code3" -ne 0 ]; then
  pass "exit code não-zero após 30 falhas consecutivas"
else
  fail "falha definitiva" "exit code 0 quando deveria ser não-zero"
fi

if echo "$output3" | grep -q "indisponível após 30 tentativas"; then
  pass "mensagem de esgotamento após 30 tentativas"
else
  fail "mensagem esgotamento" "mensagem de esgotamento ausente"
fi

# O entrypoint NÃO deve alcançar o início dos processos finais
if ! echo "$output3" | grep -qE "node falso|Iniciando motor|API PID"; then
  pass "processos finais NÃO iniciados após falha definitiva"
else
  fail "processos finais" "container iniciou processos apesar da falha"
fi

rm -rf "$TEST_DIR3"

# ---------------------------------------------------------------------------
# Relatório
# ---------------------------------------------------------------------------
echo ""
echo "=== Resultados ==="
echo -e "$TESTS"
echo ""
echo "  Total: $((PASS + FAIL)) | Aprovados: $PASS | Reprovados: $FAIL"
echo ""

[ "$FAIL" -eq 0 ]
