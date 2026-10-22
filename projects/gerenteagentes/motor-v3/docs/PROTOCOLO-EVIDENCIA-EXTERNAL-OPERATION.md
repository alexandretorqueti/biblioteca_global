# Protocolo de evidência para `external_operation`

Subtarefas classificadas como `external_operation` dependem de uma operação fora do código e, portanto, não precisam produzir diff Git. Elas não podem, porém, ser concluídas com `::DONE::` seco.

Antes do marcador final, a resposta deve conter os dois campos estruturados abaixo, com conteúdo observável:

```text
O que foi feito: <ação externa executada>
Como verificar: <passos, comando, URL, estado ou outro critério independente>
::DONE::
```

O Motor recusa a conclusão quando qualquer campo está ausente ou vazio. A recusa vale para a execução normal e para o pós-processamento de uma sessão recuperada; o fluxo existente registra falha/retry e não grava `verified`.

`analysis` e `no_code_change` preservam o contrato anterior e podem concluir sem diff Git. `external_operation` também pode concluir sem diff, mas somente após fornecer o que foi feito e como verificar.
