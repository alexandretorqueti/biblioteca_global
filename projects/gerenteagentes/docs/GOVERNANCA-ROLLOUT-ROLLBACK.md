# Rollout e rollback da governança de falhas do Motor v3

## Autoridade normal

Os pontos migrados chamam `GovernedFailureHandler` em produção. A autoridade
do catálogo é opt-in por ponto: a chave `governed_failure_<ponto>` precisa
existir em `motor_configuracoes` e ter valor booleano verdadeiro (`true`, `1`,
`on`, `yes` ou `sim`).

Se a chave não existir, estiver inválida ou a leitura falhar, o handler mantém
o comportamento legado do ponto. A leitura é feita por chamada, portanto a
alteração da flag não exige restart.

Pontos atualmente roteados:

- `analysis_terminal`, `analysis_model_fallback`, `analysis_invalid_reply` e `analysis_timeout`;
- `worker_exhausted`, `baseline_red`, `gate_result` e `monitor_recovery_failed`;
- `deploy_dispatch_failed`, `deploy_failed`, `deploy_pre_gate_failed` e `promotion_conflict`;
- `queue_invalid_message`, `queue_max_attempts` e `queue_unexpected_state`.

Uma flag só deve ser ligada depois de confirmar que o evento, a reação, a ação
terminal e todas as primitivas referenciadas estão ativos no catálogo. H5
(claim órfão) permanece uma invariável de reconciliação e não usa essa chave.

## Procedimento de ativação

1. Validar a regra com dry-run e conferir a cadeia até uma reação terminal.
2. Ativar somente a chave do ponto avaliado em `motor_configuracoes`.
3. Observar `motor_occurrences`, `motor_event_log` e os logs de operação.
4. Avançar para o próximo ponto somente após confirmar paridade com o ramo legado.

## Rollback

Desligar a chave do ponto afetado:

```sql
UPDATE motor_configuracoes
SET valor = 'false'
WHERE chave = 'governed_failure_<ponto>';
```

Se a configuração estiver indisponível, o próprio resolver considera a flag
desligada. O rollback não remove eventos, reações ou versões do catálogo e não
faz DELETE físico; a correção da regra pode ser feita desativando a versão
incorreta e ativando uma versão validada.

Após o rollback, confirmar que novas ocorrências seguem o ramo legado e que a
falha original não foi mascarada. Ações já executadas não são desfeitas
automaticamente: qualquer compensação deve ser uma ação explícita e idempotente
do catálogo.

