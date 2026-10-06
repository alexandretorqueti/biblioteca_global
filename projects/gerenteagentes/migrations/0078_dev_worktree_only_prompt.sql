-- O workspace informado é absoluto e é o único checkout autorizado ao DEV.
SET NAMES utf8mb4;

UPDATE prompts_agentes p
JOIN prompts_versoes v ON v.id=p.versao_ativa_id
SET v.texto=REPLACE(v.texto,
  'Workspace: **WORKSPACE**',
  'Workspace autorizado (caminho absoluto): **WORKSPACE**\n\nEdite exclusivamente este workspace autorizado. É expressamente proibido editar o checkout principal, fazer push ou deploy. Se uma tentativa for rejeitada por worktree inalterado, mova ou refaça as mudanças dentro deste workspace antes de responder ::DONE::.'),
  p.conteudo=REPLACE(p.conteudo,
  'Workspace: **WORKSPACE**',
  'Workspace autorizado (caminho absoluto): **WORKSPACE**\n\nEdite exclusivamente este workspace autorizado. É expressamente proibido editar o checkout principal, fazer push ou deploy. Se uma tentativa for rejeitada por worktree inalterado, mova ou refaça as mudanças dentro deste workspace antes de responder ::DONE::.')
WHERE p.chave='dev.primeira_rodada_tarefa';
