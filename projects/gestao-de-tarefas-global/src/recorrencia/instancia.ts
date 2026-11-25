/**
 * Mapeamento regra → instância de tarefa (função pura).
 *
 * O agendador (subtarefa 2) chama `montarInstancia` no instante de geração
 * e insere o payload em `tarefas`. As DECISÕES de mapeamento ficam registradas
 * aqui, de propósito, para que o agendador não invente campos:
 *
 * - `criadoPorId = responsavelId` — `tarefas.criadoPorId` é NOT NULL e a regra
 *   não tem autor; a instância nasce como se o responsável a tivesse criado;
 * - `prazo = NULL` — lembrete é responsabilidade da tarefa 5 e decisão do
 *   Alexandre (2026-10-22): tarefa sem prazo não tem lembrete; instâncias
 *   geradas automaticamente não nascem com prazo;
 * - `prioridade = 'media'` — default de `tarefas.prioridade` (schema.ts);
 * - `status = 'aberta'` — default de `tarefas.status`;
 * - `regraRecorrenciaId = regra.id` — vínculo instância ↔ regra (aceite:
 *   apagar/desativar a regra NÃO apaga as instâncias já geradas — a FK é
 *   opcional/sem cascade em `tarefas`, então o vínculo só documenta origem).
 */
import type { RegraRecorrencia } from "./tipos"

/** Payload de insert em `tarefas` derivado de uma regra (formatos do CRUD). */
export interface InstanciaTarefa {
  organizacaoId: number
  titulo: string
  descricao: string | null
  areaId: number
  responsavelId: number
  criadoPorId: number
  prioridade: "baixa" | "media" | "alta" | "urgente"
  prazo: string | null
  status: "aberta"
  /** Vínculo instância ↔ regra geradora. */
  regraRecorrenciaId: number
}

/**
 * Monta a instância de tarefa gerada em `geradaEm`.
 *
 * Copia de `regras_recorrencia`: `organizacaoId`, `titulo`, `descricao`,
 * `areaId`, `responsavelId`. `geradaEm` documenta o instante da geração
 * (o agendador o usa para idempotência/auditoria; as colunas `createdAt` do
 * banco registram o insert — a função permanece pura e determinística).
 */
export function montarInstancia(regra: RegraRecorrencia, geradaEm: Date): InstanciaTarefa {
  void geradaEm // instante da geração — registrado pelo agendador (auditoria)
  return {
    organizacaoId: regra.organizacaoId,
    titulo: regra.titulo,
    descricao: regra.descricao,
    areaId: regra.areaId,
    responsavelId: regra.responsavelId,
    criadoPorId: regra.responsavelId, // DECISÃO: NOT NULL; regra não tem autor
    prioridade: "media", // DECISÃO: default do schema
    prazo: null, // DECISÃO: sem prazo → sem lembrete (tarefa 5)
    status: "aberta",
    regraRecorrenciaId: regra.id,
  }
}
