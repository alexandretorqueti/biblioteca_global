# Política de retenção e execução automática

## Regra

Usuários sem atividade por cinco anos são identificados pela data de atualização
da conta (`updated_at`) e desativados por soft delete. A conta não é apagada
fisicamente: o histórico necessário para obrigações legais e defesa de direitos
é preservado pelo prazo aplicável.

## Job automático

`RetencaoService` agenda uma execução diária ao inicializar o módulo LGPD. Em
cada execução, consulta usuários ativos cujo `updated_at` seja anterior à data
de corte de cinco anos, marca cada conta como inativa e registra a ação em
`logs_acesso_dados_sensiveis` com `acao=retencao_desativacao`.

Falhas de uma execução devem ser observadas e reprocessadas na próxima janela;
operações já concluídas permanecem idempotentes porque somente usuários ativos
são selecionados.

## Execução manual

Administradores globais podem executar imediatamente:

```text
POST /api/admin/executar-retencao
```

A rota exige JWT válido, escopo do projeto `biblioteca-global` e perfil
`admin`. A resposta informa a quantidade de usuários desativados.

## Exceções e governança

A retenção pode ser suspensa para dados sujeitos a obrigação legal, investigação
ou exercício regular de direitos. Qualquer exceção deve ser registrada e
reavaliada pelo DPO em `privacidade@globaltecnologia.com.br`.
