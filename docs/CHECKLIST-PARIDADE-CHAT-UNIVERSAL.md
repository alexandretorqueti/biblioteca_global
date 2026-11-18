# Checklist de Paridade — Chat Universal (isa + alpha)

> Tarefa: isas-mt-03 (migrar Isa e Alpha como primeiros tenants do genérico).
> Este checklist é executado na **subtarefa 3** (validação automatizada/dirigida) e no
> **aceite humano pós-deploy**, em **ambos os tenants**, contra o bundle único
> `biblioteca-global-chat-universal` roteado pelo `chat-proxy` por `server_name`.
>
> Referência de comparação: estado atual de `projects/isa-chat` e `projects/alpha-chat`
> (legados, intactos — subíveis com `docker compose --profile legacy up isa-chat alpha-chat`
> para comparação lado a lado).

## Infra / roteamento

- [ ] `docker compose config` válido (sem erro de parse/interpolação).
- [ ] `biblioteca-global-chat-universal` no ar na porta host `8084` (ou `CHAT_UNIVERSAL_HOST_PORT`).
- [ ] `isa-chat` e `alpha-chat` **não** sobem no `up` padrão (profiles: `legacy`); pastas `projects/isa-chat` e `projects/alpha-chat` intactas.
- [ ] `chat-proxy` sobe e depende apenas de `chat-universal`.
- [ ] `https://isa.globaltecnologia.net` (e `isa.webconnect.com.br`) respondem pelo chat-universal.
- [ ] `https://alpha.globaltecnologia.net` (e `alpha.webconnect.com.br`) respondem pelo chat-universal.
- [ ] Os dois domínios são servidos pelo **mesmo build** (mesmo container/imagem — conferir `docker inspect` / hash do bundle).
- [ ] `GET /health` retorna `ok` em ambos os domínios (via proxy e direto no container).
- [ ] `proxy_set_header Host $host` preservado no chat-proxy (resolução de tenant depende do Host original) — acessar um domínio não exibe o tenant do outro.
- [ ] Headers `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` presentes no proxy para a API.
- [ ] Rede compartilhada `biblioteca-shared` (`biblioteca-global_default`) preservada; alias `biblioteca-api` resolve para a API ativa (blue/green).

## Identidade visual e textos (por tenant)

### Isa (isa.globaltecnologia.net)

- [ ] Textos de boas-vindas/assistência idênticos ao isa-chat legado (comparar mensagem a mensagem).
- [ ] Cores/paleta idênticas ao legado.
- [ ] Avatar/idem legado exibido corretamente.
- [ ] Título/ícone da aba do navegador idênticos.

### Alpha (alpha.globaltecnologia.net)

- [ ] Textos idênticos ao alpha-chat legado.
- [ ] Cores/paleta idênticas ao legado.
- [ ] Avatar `alpha-avatar.png` idêntico ao legado.
- [ ] Título/ícone da aba do navegador idênticos.

## Sidebar (ambos os tenants)

- [ ] Nome do usuário logado exibido.
- [ ] E-mail do usuário logado exibido.
- [ ] Foto (avatar do usuário) exibida.
- [ ] Entradas de definições/configurações presentes e funcionais como no legado.
- [ ] Botão "Sair" encerra a sessão corretamente (mesmo comportamento do legado).

## Autenticação / verificação por e-mail

- [ ] Fluxo de verificação por e-mail completo: solicitar código → receber e-mail → inserir código → acesso liberado.
- [ ] Estados da verificação (enviando, aguardando código, código inválido, expirado, sucesso) exibidos como no legado.
- [ ] Badge de estado (verificado/não verificado) igual ao legado.
- [ ] E-mail de login persistido em `<tenant>.loginEmail` (`isa.loginEmail` / `alpha.loginEmail`).

## Sessão / localStorage (CRÍTICO — não perder sessões existentes)

- [ ] Isa: chave `isa.chatId` lida/escrita exatamente como no legado (visitante com sessão prévia mantém o histórico).
- [ ] Alpha: chave `alpha.chatId` lida/escrita exatamente como no legado.
- [ ] Nenhuma chave nova/renomeada que abandone os `chatId`s já existentes nos navegadores.
- [ ] Sem vazamento entre tenants: sessão isa não aparece no domínio alpha e vice-versa (origens distintas).

## Conversa

- [ ] Envio e recebimento de mensagens com resposta do agente correto por tenant (ISA vs. Alpha — persona/config do projeto).
- [ ] **Polling a cada 5s** mantido (verificar cadência na aba Network).
- [ ] **Loader/indicador de "digitando"/aguardando** exibido como no legado.
- [ ] Renderização de markdown/formatting igual ao legado.

## Anexos

- [ ] Upload dos tipos de anexo aceitos pelo legado funciona (conferir whitelist por tenant — imagens, documentos etc.).
- [ ] Anexos enviados aparecem na conversa com pré-visualização/download como no legado.
- [ ] Anexos recebidos do agente renderizam como no legado.
- [ ] Limite de tamanho de anexo comporta-se como no legado (mensagem de erro idêntica).

## Fluxo ponta a ponta (smoke por domínio)

- [ ] Acessar `isa.globaltecnologia.net` → loader → verificação/login → enviar mensagem → resposta → anexo → sidebar correta → Sair.
- [ ] Mesma sequência em `alpha.globaltecnologia.net`.
- [ ] API da Biblioteca reachable via `/api/` no bundle (alias `biblioteca-api`), sem erro de CORS/rota.

## Encerramento (após aceite)

- [ ] Aceite humano registrado por Alexandre.
- [ ] Somente então: remover profiles `legacy` / aposentar containers isa-chat e alpha-chat em produção.
- [ ] Manter as pastas `projects/isa-chat` e `projects/alpha-chat` no repositório até ordem explícita de exclusão.

---

**Assinatura do aceite:**
- Isa: [ ] datas / observações
- Alpha: [ ] datas / observações
