# ESPEC-CRUD — Vitrine IA — loja de atendentes virtuais

> Fonte: `geracoes_projeto.id=10` → campo `tasks.especificacaoCrud` (database projeto_640), plano macro #10, posição 1/11.
> Este arquivo é a fonte de verdade para `schema.ts` e `config.ts` do projeto. O JSON canônico integral está no apêndice ao final.

## Entidades (10)

### planos

- **Menu:** Vitrine > Planos

Campos:

- `nome varchar(120) req`
- `tagline varchar(200)`
- `precoMensal decimal(10,2) money req`
- `precoSetup decimal(10,2) money`
- `beneficios json lista`
- `textoBotao varchar(60)`
- `maisPopular boolean switch`
- `ordem int`
- `ativo boolean default true`

Máscaras/validações:

- money BRL pt-BR nos preços
- required nome/precoMensal
- min 0 preços

### itens_faq

- **Menu:** Vitrine > FAQ

Campos:

- `pergunta text req textarea`
- `resposta text req textarea`
- `ordem int`
- `ativo boolean default true`

Máscaras/validações:

- required pergunta/resposta
- maxLength 500 pergunta

### metricas_destaque

- **Menu:** Vitrine > Métricas

Campos:

- `valor varchar(30) req (ex 24/7)`
- `rotulo varchar(120)`
- `ordem int`
- `ativo boolean default true`

Máscaras/validações:

- required valor
- maxLength 30 valor

### segmentos

- **Menu:** Vitrine > Segmentos

Campos:

- `titulo varchar(120) req`
- `descricao text textarea`
- `icone varchar(60) nome-do-ícone`
- `ordem int`
- `ativo boolean default true`

Máscaras/validações:

- required titulo

### textos_vitrine

- **Menu:** Vitrine > Textos

Campos:

- `chave varchar(80) req unique (hero_titulo, whatsapp_link...)`
- `conteudo text req textarea`
- `secao select hero|dores|beneficios|como_funciona|cta|contato`
- `ativo boolean default true`

Máscaras/validações:

- required chave/conteudo
- unique chave no backend

### pedidos

- **Menu:** Vendas > Pedidos (childRoutes documentos/agente)

Campos:

- `nomeNegocio varchar(160) req`
- `nomeContato varchar(160) req`
- `email varchar(160) req`
- `telefone varchar(20) req`
- `planoId FK planos multipleChoice req`
- `ciclo enum mensal|anual req`
- `informacoesNegocio text textarea`
- `status enum criado|aguardando_pagamento|pago|provisionando|entregue|falha default criado readOnly`
- `pagamentoId varchar(120) readOnly`
- `linkAgente varchar(300) readOnly`
- `scriptEmbed text readOnly`
- `consentimentoLgpd boolean req`
- `criadoEm/emAtualizacao timestamps`

Máscaras/validações:

- tipo email nativo
- mask+validator telefone
- validator nomeCompleto em nomeContato
- required nos campos req
- status/editáveis só via backend

### documentos

- **Menu:** childRoute de Pedidos

Campos:

- `pedidoId FK pedidos req`
- `nomeOriginal varchar(255)`
- `mimeType varchar(120)`
- `tamanhoBytes bigint`
- `caminhoArmazenamento varchar(500) readOnly`
- `tipoConteudo enum pdf|docx|txt|texto_livre req`
- `textoExtraido longtext readOnly`

Máscaras/validações:

- accept .pdf,.docx,.txt + maxFileSizeMb no upload custom
- required pedidoId/tipoConteudo

### agentes_provisionados

- **Menu:** Agentes > Agentes Provisionados (childRoutes integrações/whatsapp)

Campos:

- `pedidoId FK pedidos unique req`
- `openclawAgenteId varchar(120) readOnly`
- `nome varchar(160)`
- `status enum pendente|provisionando|ativo|falha readOnly`
- `personalidade json readOnly`
- `linkAcesso varchar(300) readOnly`
- `scriptEmbed text readOnly`
- `tentativas int default 0 readOnly`
- `ultimoErro text readOnly`

Máscaras/validações:

- required pedidoId
- campos de fluxo somente leitura

### integracoes_externas

- **Menu:** Agentes > Integrações

Campos:

- `pedidoId FK pedidos req (vínculo cliente)`
- `nome varchar(120) req`
- `urlBase varchar(300) req`
- `tipoAutenticacao enum api_key|oauth2|nenhuma req`
- `credenciaisCifradas text WRITE-ONLY nunca retornado`
- `headers json`
- `limiteRequisicoesMinuto int`
- `somenteLeitura boolean default true readOnly fase1`
- `ativo boolean switch default true`

Máscaras/validações:

- required nome/urlBase/tipoAutenticacao
- min 1 limite
- validação URL backend
- credenciaisCifradas oculta em grid/detalhe/respostas

### configuracoes_whatsapp

- **Menu:** childRoute de Agentes Provisionados

Campos:

- `agenteId FK agentes_provisionados unique req`
- `statusPareamento enum pendente|qr_gerado|pareado|expirado default pendente readOnly`
- `alcance enum todos|whitelist default todos`
- `numerosPermitidos json lista E.164`
- `ultimoQrGeradoEm datetime readOnly`

Máscaras/validações:

- required agenteId
- whitelist exige numerosPermitidos não vazio (backend)

## Observações

schema.ts fonte única; migrations drizzle-kit; whitelist no schema-registry; regra das duas fontes (config.ts + config core); campos de fluxo insertable/editable=false — transições só no backend; credenciaisCifradas write-only; upload é lacuna (tarefa 3); auth única passwordless + perfis nativos cobrem o painel; vitrine pública usa endpoints próprios, nunca CRUD autenticado; projeto já provisionado (projetoId 8509).

## Apêndice — JSON canônico (especificacaoCrud, geracoes_projeto #10)

```json
{
  "entidades": [
    {
      "menu": "Vitrine > Planos",
      "nome": "planos",
      "campos": [
        "nome varchar(120) req",
        "tagline varchar(200)",
        "precoMensal decimal(10,2) money req",
        "precoSetup decimal(10,2) money",
        "beneficios json lista",
        "textoBotao varchar(60)",
        "maisPopular boolean switch",
        "ordem int",
        "ativo boolean default true"
      ],
      "mascarasValidacoes": [
        "money BRL pt-BR nos preços",
        "required nome/precoMensal",
        "min 0 preços"
      ]
    },
    {
      "menu": "Vitrine > FAQ",
      "nome": "itens_faq",
      "campos": [
        "pergunta text req textarea",
        "resposta text req textarea",
        "ordem int",
        "ativo boolean default true"
      ],
      "mascarasValidacoes": [
        "required pergunta/resposta",
        "maxLength 500 pergunta"
      ]
    },
    {
      "menu": "Vitrine > Métricas",
      "nome": "metricas_destaque",
      "campos": [
        "valor varchar(30) req (ex 24/7)",
        "rotulo varchar(120)",
        "ordem int",
        "ativo boolean default true"
      ],
      "mascarasValidacoes": [
        "required valor",
        "maxLength 30 valor"
      ]
    },
    {
      "menu": "Vitrine > Segmentos",
      "nome": "segmentos",
      "campos": [
        "titulo varchar(120) req",
        "descricao text textarea",
        "icone varchar(60) nome-do-ícone",
        "ordem int",
        "ativo boolean default true"
      ],
      "mascarasValidacoes": [
        "required titulo"
      ]
    },
    {
      "menu": "Vitrine > Textos",
      "nome": "textos_vitrine",
      "campos": [
        "chave varchar(80) req unique (hero_titulo, whatsapp_link...)",
        "conteudo text req textarea",
        "secao select hero|dores|beneficios|como_funciona|cta|contato",
        "ativo boolean default true"
      ],
      "mascarasValidacoes": [
        "required chave/conteudo",
        "unique chave no backend"
      ]
    },
    {
      "menu": "Vendas > Pedidos (childRoutes documentos/agente)",
      "nome": "pedidos",
      "campos": [
        "nomeNegocio varchar(160) req",
        "nomeContato varchar(160) req",
        "email varchar(160) req",
        "telefone varchar(20) req",
        "planoId FK planos multipleChoice req",
        "ciclo enum mensal|anual req",
        "informacoesNegocio text textarea",
        "status enum criado|aguardando_pagamento|pago|provisionando|entregue|falha default criado readOnly",
        "pagamentoId varchar(120) readOnly",
        "linkAgente varchar(300) readOnly",
        "scriptEmbed text readOnly",
        "consentimentoLgpd boolean req",
        "criadoEm/emAtualizacao timestamps"
      ],
      "mascarasValidacoes": [
        "tipo email nativo",
        "mask+validator telefone",
        "validator nomeCompleto em nomeContato",
        "required nos campos req",
        "status/editáveis só via backend"
      ]
    },
    {
      "menu": "childRoute de Pedidos",
      "nome": "documentos",
      "campos": [
        "pedidoId FK pedidos req",
        "nomeOriginal varchar(255)",
        "mimeType varchar(120)",
        "tamanhoBytes bigint",
        "caminhoArmazenamento varchar(500) readOnly",
        "tipoConteudo enum pdf|docx|txt|texto_livre req",
        "textoExtraido longtext readOnly"
      ],
      "mascarasValidacoes": [
        "accept .pdf,.docx,.txt + maxFileSizeMb no upload custom",
        "required pedidoId/tipoConteudo"
      ]
    },
    {
      "menu": "Agentes > Agentes Provisionados (childRoutes integrações/whatsapp)",
      "nome": "agentes_provisionados",
      "campos": [
        "pedidoId FK pedidos unique req",
        "openclawAgenteId varchar(120) readOnly",
        "nome varchar(160)",
        "status enum pendente|provisionando|ativo|falha readOnly",
        "personalidade json readOnly",
        "linkAcesso varchar(300) readOnly",
        "scriptEmbed text readOnly",
        "tentativas int default 0 readOnly",
        "ultimoErro text readOnly"
      ],
      "mascarasValidacoes": [
        "required pedidoId",
        "campos de fluxo somente leitura"
      ]
    },
    {
      "menu": "Agentes > Integrações",
      "nome": "integracoes_externas",
      "campos": [
        "pedidoId FK pedidos req (vínculo cliente)",
        "nome varchar(120) req",
        "urlBase varchar(300) req",
        "tipoAutenticacao enum api_key|oauth2|nenhuma req",
        "credenciaisCifradas text WRITE-ONLY nunca retornado",
        "headers json",
        "limiteRequisicoesMinuto int",
        "somenteLeitura boolean default true readOnly fase1",
        "ativo boolean switch default true"
      ],
      "mascarasValidacoes": [
        "required nome/urlBase/tipoAutenticacao",
        "min 1 limite",
        "validação URL backend",
        "credenciaisCifradas oculta em grid/detalhe/respostas"
      ]
    },
    {
      "menu": "childRoute de Agentes Provisionados",
      "nome": "configuracoes_whatsapp",
      "campos": [
        "agenteId FK agentes_provisionados unique req",
        "statusPareamento enum pendente|qr_gerado|pareado|expirado default pendente readOnly",
        "alcance enum todos|whitelist default todos",
        "numerosPermitidos json lista E.164",
        "ultimoQrGeradoEm datetime readOnly"
      ],
      "mascarasValidacoes": [
        "required agenteId",
        "whitelist exige numerosPermitidos não vazio (backend)"
      ]
    }
  ],
  "observacoes": "schema.ts fonte única; migrations drizzle-kit; whitelist no schema-registry; regra das duas fontes (config.ts + config core); campos de fluxo insertable/editable=false — transições só no backend; credenciaisCifradas write-only; upload é lacuna (tarefa 3); auth única passwordless + perfis nativos cobrem o painel; vitrine pública usa endpoints próprios, nunca CRUD autenticado; projeto já provisionado (projetoId 8509)."
}
```
