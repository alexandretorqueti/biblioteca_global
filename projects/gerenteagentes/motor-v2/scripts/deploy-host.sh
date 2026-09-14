#!/usr/bin/env bash
# Compatibilidade: o caminho histórico continua válido para instalações que
# ainda o tenham persistido. O fluxo real fica no script blue-green.
set -euo pipefail
REPO_ROOT="${1:?informe a raiz do repositório}"
exec bash "$REPO_ROOT/projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh" "$REPO_ROOT"
