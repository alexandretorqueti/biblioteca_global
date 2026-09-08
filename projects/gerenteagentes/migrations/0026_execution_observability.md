# Migration 0026 — observabilidade de execução

A migration `0026_execution_observability.sql` é aditiva: cria tentativas,
eventos e gates, e acrescenta planejamento, ciclo de vida de bloqueios e
estado pós-deploy às entidades existentes. Nenhuma linha existente é alterada.

As evidências persistidas pela camada de aplicação devem ser JSON resumido,
sem segredos, limitado a 8 KiB por gate; saída de comando completa fica fora
do banco. `deployada` continua aceito apenas como legado e não é gravado por
esta migration.

O rollback está em `0026_execution_observability.rollback.sql`. Antes de
executá-lo, exporte as três tabelas novas; o rollback remove também as novas
colunas, portanto é uma operação destrutiva sobre os dados adicionados por
esta migration.
