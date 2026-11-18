# Funil de venda self-service da Isa

## Decisão

A vendedora é a própria Isa. Não há agente irmão nesta entrega: a página já usa a Isa como demonstração, o custo operacional é zero e o contexto comercial é injetado por turno.

## Como a conversa funciona

O backend injeta o bloco `[Estado da venda]` em cada turno, depois do bloco de onboarding. O bloco contém o `chatId` técnico, o contrato das ferramentas, os dados persistidos do negócio, documentos recebidos, plano/pedido e o próximo passo. A Isa conduz a conversa, mas não valida dados: toda validação é determinística nos DTOs e serviços da API.

Sem negócio iniciado, a Isa oferece o produto quando o cliente demonstra interesse e começa com `anotar_negocio`. Depois, pode receber documentos de regras, consultar planos, confirmar a escolha e criar o checkout.

## Contrato das ferramentas

As ferramentas usam o `chatId` exibido no contexto atual:

| Ferramenta | Rota | Corpo | Regras do servidor |
| --- | --- | --- | --- |
| `anotar_negocio` | `POST /api/vendas/negocio` | `chatId`, `nome`, `segmentoDescricao`, `contato { nome, email, telefone }`, `transbordo { ativo, destinoNumero?, destinoNome? }` | Campos obrigatórios são validados; transbordo ativo exige número e nome do destino; operação é upsert por chat. |
| `anexar_documento_negocio` | `POST /api/vendas/negocio/documento` | `chatId`, `nome`, `mime`, `conteudoBase64` | O negócio precisa existir; MIME e tamanho são validados; o arquivo é armazenado para uso diferido, mesmo antes do RAG. |
| `escolher_plano` | `GET /api/vendas/planos` | sem corpo | O catálogo ativo vem do billing; a Isa não inventa preço, ciclo ou disponibilidade. O `slug` escolhido segue para `criar_pedido`. |
| `criar_pedido` | `POST /api/vendas/pedido` | `chatId`, `planoSlug`, `ciclo?`, `checkoutSuccessUrl`, `checkoutFailureUrl`, `checkoutPendingUrl` | O servidor valida negócio, contato, plano e ciclo e cria ou reutiliza o checkout pendente. |

O cartão nunca passa pela Isa nem pela API da conversa; o checkout é responsabilidade do PSP/billing.

## Próximos passos por estado

- Sem negócio: apresentar a solução e coletar os campos para `anotar_negocio`.
- Negócio capturado sem plano: oferecer o catálogo e chamar `escolher_plano`; documentos podem ser anexados antes do checkout.
- Plano escolhido ou pedido pendente: confirmar os dados e chamar `criar_pedido` com autorização do cliente.
- Erros ou campos faltantes: informar o retorno do servidor e pedir somente o dado necessário; nunca validar ou completar por conta própria.
