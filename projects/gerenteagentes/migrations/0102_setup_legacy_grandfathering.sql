-- Geração Macro F3 (task-p2-1058, subtarefa 1): grandfathering dos projetos
-- legados no gate de despacho do motor (setup_status != 'verified' não
-- despacha — espera de capacidade 'setup_not_verified').
--
-- DECISÃO (Alexandre, 2026-11-03): projetos legados anteriores ao fluxo de
-- captação/setup — que nunca passaram por uma tarefa setup-<slug> — são
-- marcados como verified com evidência auditável, para não ficarem barrados
-- pelo gate. Cobertura EXATA: ids 6 (sistema-adm-global), 7 (taqui) e
-- 12 (consoleopenclaw). O id=2 (gerenteagentes) NÃO é tocado — já foi
-- verificado manualmente.
--
-- DML pura e IDEMPOTENTE: o WHERE `setup_status <> 'verified'` torna a
-- segunda aplicação um no-op. Nenhuma alteração de schema.
UPDATE `projetos_captados`
   SET `setup_status` = 'verified',
       `setup_verified_at` = NOW(),
       `setup_evidence` = JSON_OBJECT(
         'legacy_grandfathered', true,
         'motivo', 'Projeto legado anterior ao fluxo de captacao/setup — nunca passou por tarefa setup-<slug>',
         'decidido_por', 'Alexandre',
         'decidido_em', '2026-11-03'
       )
 WHERE `id` IN (6, 7, 12)
   AND `setup_status` <> 'verified';
