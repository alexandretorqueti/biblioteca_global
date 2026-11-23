# Contexto do Analista — Voz na Isa
> Status: bootstrap pendente.
> Projeto: voz-na-isa
> Criado em: 2026-11-20

## Identidade técnica
_A preencher após inspeção inicial._

## Arquitetura e módulos
_A preencher após inspeção inicial._

## Fontes de verdade
_A preencher após inspeção inicial._

- **Referência de TTS funcional (Alexandre, 2026-11-23):** o BFF do OpenClaw Console
  (`/data/workspace/projects/codigofonte/openclaw-console`, `apps/server/src/index.ts`)
  já tem código parecido que funciona: `POST /api/tts` (Ollama `/v1/audio/speech`,
  modelo `phonon:40m-pt`, voz padrão `Isadora`, WAV PCM 16-bit mono 24 kHz,
  chunking de 4000 chars por requisição) e `POST /api/speech-summary` (`qwen3:8b`).
  Consultar antes de projetar a geração de voz deste projeto.

## Decisões vigentes
_Nenhuma registrada._

## Limitações e riscos conhecidos
_Nenhum registrado._

## Registro confirmado por tarefa
_Nenhuma tarefa concluída._
