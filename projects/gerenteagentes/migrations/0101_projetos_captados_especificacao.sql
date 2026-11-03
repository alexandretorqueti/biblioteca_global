-- Geração Macro F3 (task-p2-1058, subtarefa 1): coluna de especificação do
-- projeto captado (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §4/§8 — F3).
--
-- Migration estritamente ADITIVA: ALTER TABLE ADD COLUMN NULLABLE.
-- Nenhum DROP/RENAME/MODIFY de colunas existentes.
--
-- `especificacao` guarda a especificação do projeto gravada pelo setup
-- (passo 1.1.x — mesma fonte de projects/<slug>/docs/ESPECIFICACAO.md).
-- Enquanto a Isa não produz o documento completo (F4), o campo aceita a
-- descrição estendida. O ProjectGenerationWorker prefere esta coluna quando
-- não-vazia e cai em `descricao` como fallback documentado.
ALTER TABLE `projetos_captados`
  ADD COLUMN `especificacao` longtext NULL;
