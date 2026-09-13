# Contexto do Analista — Gerente de Agentes

Este é o ponto de entrada para análise de tarefas deste projeto. Leia-o antes de planejar e use os documentos e o código referenciados como fontes de aprofundamento. Código, contratos e configuração vigente prevalecem sobre este resumo.

## Identidade e escopo

- Projeto: Motor-v2, orquestração de agentes e execução de tarefas; não duplicar identidade, RBAC, usuários ou telas da plataforma Biblioteca Global.
- Repositório canônico: `projects/gerenteagentes`, branch raiz `base-desenvolvimento`.
- Segredos não entram no repositório, prompts ou contexto. Configuração do OpenClaw/Gateway não pode ser alterada por tarefas do projeto.

## Arquitetura operacional

- `motor-v2/src/coordinator/TaskCoordinator.ts` agenda análise, execução, integração e promoção.
- `motor-v2/src/workers/TaskWorker.ts` executa análise, preparo, desenvolvimento e gates.
- A API/plataforma está em `api/`; migrations e `schema.ts` definem persistência e contratos de dados.
- Prompts ativos são versionados no banco: `prompts_agentes` aponta para `prompts_versoes`; fallback de código não prevalece sobre versão ativa.

## Fluxo e Git

Cada tarefa usa a branch `motor-v2/<tarefa>/integracao`; subtarefas usam worktrees derivados dela. Só após gates e integração a branch da tarefa é promovida para a base. Referência: `docs/MOTOR-BRANCH-INTEGRACAO-POR-TAREFA.md`.

## Fontes obrigatórias por tema

- Estados, chat e clarificação: `docs/STATUS-DERIVADO-DE-TAREFAS.md`, `docs/ANALISTA_INTERATIVO_CHAT.md`.
- Plano, cobertura e refutação: `docs/PLANO_ANALISTA_E_COBERTURA.md`, `docs/P2-PROMPTS-E-REFUTACAO-DE-PREMISSA.md`.
- Worktree/sessão: `motor-v2/docs/CONTRATO-WORKSPACE-SESSAO.md`.
- Configurações: `docs/MAPEAMENTO-CONFIGURACOES-MOTOR.md`.

## Regras de análise

1. Diferencie fato verificado, hipótese e decisão pendente.
2. Antes de propor mudança, localize arquivos, contratos, testes e dependências reais.
3. Pergunte no chat quando faltar decisão de produto, escopo ou autorização; não invente infraestrutura, credenciais ou caminhos.
4. Planeje contratos/dados/verificadores antes de orquestração/interface e explicite dependências.

## Atualização deste arquivo

Somente a revisão final deve registrar conhecimento confirmado nesta seção, associado à tarefa e sem duplicar entradas. A escrita deve ocorrer na branch de integração, nunca diretamente na base durante a análise.

## Registro confirmado por tarefa

_Ainda não há entradas confirmadas._
