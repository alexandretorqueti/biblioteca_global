# Especificação — Voz na Isa

## Visão geral
Voz na Isa é a camada de voz do atendimento inteligente da Global Tecnologia, aplicada ao chat do Atendente-MT (projeto chat-universal do monorepo biblioteca-global), com extensão futura aos demais tenants. Cada mensagem da Isa poderá ser lida em voz alta e, em etapas seguintes, o usuário poderá conversar por voz num "modo voz" com orbe animado no centro da tela. Todo o processamento de voz (síntese e transcrição) é 100% self-hosted no ServerIA, sem nenhum serviço externo, por privacidade/LGPD e compatibilidade ampla de navegadores. O projeto é capturado separadamente (escopo, orçamento e backlog próprios), mas o desenvolvimento acontece no repositório existente (layout monorepo), sem quebrar o chat de texto atual.

## Atores/papéis
- Visitante/cliente do chat: ouve as mensagens da Isa e (Fases 2/3) fala com ela.
- Isa (agente de atendimento): passa a responder também em voz; suas mensagens de texto continuam chegando normalmente.
- Administração do ServerIA: responsável pela operação do voice-gateway, do ollama (phonon) e do Vosk, incluindo o controle de VRAM.

## Requisitos funcionais
- RF-1: Cada mensagem da Isa ganha um ícone de alto-falante; ao clicar, a mensagem é lida em voz alta (voz feminina pt-BR "Isadora").
- RF-2: Modo voz com orbe azul animado e vibrante no centro da tela (estilo ChatGPT), com 4 estados: ocioso, ouvindo, pensando e falando.
- RF-3: O orbe reage ao áudio real: pulsa ao ouvir, vibra ao falar e gira enquanto "pensa" (React + canvas/Web Audio API, com AnalyserNode dirigindo a animação pelo nível real do áudio).
- RF-4: No modo voz, o usuário fala pelo microfone; a fala é transcrita em tempo real e vira mensagem normal no chat.
- RF-5: TTS self-hosted via ollama no ServerIA, modelo phonon:40m-pt com voz Isadora — nenhum serviço externo de voz.
- RF-6: Novo app voice-gateway no monorepo (Fastify, no compose padrão junto ao chat-proxy) expondo POST /api/voice/tts (texto → áudio MP3/Opus, nunca WAV cru na web) e WebSocket /api/voice/stt-stream.
- RF-7: TTS com streaming por sentença: a resposta da Isa é quebrada em frases sintetizadas em fila, para a voz começar em ~1s sem esperar o texto completo.
- RF-8: STT em tempo real com Vosk (modelo pt-BR), 100% local — sem Google/Web Speech API (privacidade/LGPD e compatibilidade com Firefox).
- RF-9: Fase 1 (MVP): ícone de alto-falante por mensagem + voice-gateway TTS + playback.
- RF-10: Fase 2: microfone com Vosk em push-to-talk + transcrição virando mensagem no chat.
- RF-11: Fase 3: modo voz contínuo com o orbe e turno automático (detecção de fim de fala).
- RF-12: Escopo do MVP no Atendente-MT (chat-universal) sem quebrar o chat de texto atual; extensão futura para os outros tenants.
- RF-13: Rotas /api/voice/* expostas via chat-proxy/túnel cloudflared, com atenção à VRAM do ServerIA (phonon e Vosk são leves e não devem competir com os modelos grandes do motor).
- RF-14: Aceite da Fase 1: clicar no alto-falante de uma mensagem da Isa em isa.globaltecnologia.net e ouvir a resposta completa em pt-BR com início em até ~2s, em Chrome e Firefox.
- RF-15: Dados de voz são descartáveis: nenhum áudio (TTS ou microfone) é armazenado; apenas o texto transcrito vira mensagem no chat.
- RF-16: O modo voz deve funcionar bem também em celular (navegador mobile), além do desktop.

## Requisitos não-funcionais
- Latência: início da fala em até ~1-2s (streaming por sentença no TTS; aceite formal da Fase 1: ~2s).
- Privacidade/LGPD: processamento de voz 100% local; áudios descartáveis (nenhum armazenamento); nada de API externa de voz ou de transcrição.
- Compatibilidade: Chrome e Firefox (desktop) e navegadores mobile; Web Speech API vetada justamente por incompatibilidade com Firefox.
- Formato de áudio na web: MP3/Opus (nunca WAV cru).
- Recursos do servidor: phonon e Vosk leves; devem conviver com os modelos do motor sem competir pela VRAM do ServerIA.
- Estabilidade: o chat de texto existente não pode quebrar — a voz é camada adicional.

## Entidades de dados
- Mensagem de chat (existente no chat-universal): ganha capacidade de leitura em voz alta; a transcrição de fala entra como mensagem normal.
- Áudio TTS / áudio do microfone: efêmeros por decisão — descartados após uso, nunca persistidos.
- Demais entidades do projeto de origem: inalteradas.

## Integrações
- ollama no ServerIA (modelo phonon:40m-pt, voz Isadora) para TTS.
- Vosk (modelo pt-BR, local) para STT em tempo real via WebSocket.
- voice-gateway (novo app Fastify no monorepo): POST /api/voice/tts e WS /api/voice/stt-stream.
- chat-proxy + túnel cloudflared: exposição pública das rotas /api/voice/*.
- chat-universal (front existente): consumo do áudio e da transcrição; componente AgentChat em packages/ui.

## Fora de escopo
- Extensão do modo voz aos outros tenants no MVP (prevista para depois, via arquitetura multi-tenant do chat-universal).
- Qualquer serviço externo de voz (Google, AWS, Azure, Web Speech API etc.).
- Armazenamento de áudio (TTS ou gravações do usuário).
- Alterações no backend de atendimento/agentes (OpenClaw/motor) além do necessário para o fluxo de áudio.
- Provisionamento de repositório novo: o desenvolvimento ocorre no monorepo biblioteca-global existente (projeto capturado com repo_path apontando para ele, layout monorepo).
