// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseGenerationReply, type GenerationOutcome, type MacroPlano } from '../src/generation/GenerationPlanContract.js'

/**
 * Regressão do incidente vitrine-ia (27/11/2026, cadeia 1137-1147): plano
 * macro aprovado com a CABECA da cadeia (menor seq, depende_de=[]) marcada
 * com auto_start=false deixava a primeira tarefa órfã de gatilho — dispatch
 * exige auto_start=1 e a retomada da tarefa 1121 só aciona dependentes na
 * CONCLUSAO da dependencia. A cabeca nunca tem dependencia concluida, então
 * esperava inicio manual indefinidamente.
 *
 * Contrato: o parser NORMALIZA a cabeca para auto_start=true e registra aviso
 * legivel em `outcome.avisos` — sem lancar contract_violation (o plano nao e
 * rejeitado por isso) e sem poluir o JSON do plano (apenas campos do §5).
 */

interface TaskSpec {
  seq: number
  depende_de: number[]
  auto_start: boolean
}

function tarefa(spec: TaskSpec): Record<string, unknown> {
  return {
    seq: spec.seq,
    titulo: `Tarefa ${spec.seq}`,
    objetivo: `Objetivo ${spec.seq}.`,
    escopo: `Escopo ${spec.seq}.`,
    aceite: [`Aceite ${spec.seq}`],
    requisitos: [`REQ-F-00${spec.seq}`],
    executor: 'biblioteca-global',
    depende_de: spec.depende_de,
    auto_start: spec.auto_start,
    risco: 'medio',
  }
}

function planoJson(tarefas: TaskSpec[]): string {
  return JSON.stringify({
    kind: 'plano',
    classificacaoSistema: '100% crud',
    requerAgenteDedicado: false,
    requisitos: tarefas.map(spec => ({
      id: `REQ-F-00${spec.seq}`,
      texto: `Requisito da tarefa ${spec.seq}.`,
      origem: 'captura',
      classificacao: 'crud',
    })),
    especificacaoCrud: {
      entidades: [{ nome: `entidade-${tarefas[0]!.seq}`, campos: ['nome'], mascarasValidacoes: [] }],
    },
    tarefas: tarefas.map(tarefa),
    matrizCobertura: tarefas.map(spec => ({ req: `REQ-F-00${spec.seq}`, cobertoPor: `tarefa:${spec.seq}` })),
    lacunas: [],
    lacunasBiblioteca: [],
    riscos: [],
    foraDeFase: [],
  })
}

function comoPlano(content: string): Extract<GenerationOutcome, { kind: 'plano' }> {
  const outcome = parseGenerationReply(content)
  if (outcome.kind !== 'plano') throw new Error(`esperado forma "plano", obtido "${outcome.kind}"`)
  return outcome
}

function autoStartDe(plano: MacroPlano, seq: number): boolean {
  const found = plano.tarefas.find(item => item.seq === seq)
  if (!found) throw new Error(`tarefa seq ${seq} não encontrada`)
  return found.auto_start
}

describe('parseGenerationReply — normalização da cabeça da cadeia (auto_start)', () => {
  it('cabeça (menor seq) com auto_start=false → corrigida para true + aviso, sem contract_violation', () => {
    const outcome = comoPlano(planoJson([
      { seq: 1, depende_de: [], auto_start: false },
      { seq: 2, depende_de: [1], auto_start: false },
    ]))

    expect(autoStartDe(outcome.plano, 1)).toBe(true)
    const avisos = outcome.avisos ?? []
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('Normalização automática')
    expect(avisos[0]).toContain('seq 1')
    expect(avisos[0]).toContain('cabeça da cadeia')
    expect(avisos[0]).toContain('plano aprovado inicia sem intervenção manual')
  })

  it('cabeça já com auto_start=true → nenhum aviso (plano preservado)', () => {
    const outcome = comoPlano(planoJson([
      { seq: 1, depende_de: [], auto_start: true },
      { seq: 2, depende_de: [1], auto_start: false },
    ]))

    expect(outcome.avisos ?? []).toHaveLength(0)
    expect(autoStartDe(outcome.plano, 1)).toBe(true)
    expect(autoStartDe(outcome.plano, 2)).toBe(false)
  })

  it('demais tarefas preservam o auto_start do plano (só a cabeça é normalizada)', () => {
    const outcome = comoPlano(planoJson([
      { seq: 1, depende_de: [], auto_start: false },
      { seq: 2, depende_de: [1], auto_start: false },
      { seq: 3, depende_de: [2], auto_start: true },
    ]))

    expect(autoStartDe(outcome.plano, 1)).toBe(true)
    expect(autoStartDe(outcome.plano, 2)).toBe(false)
    expect(autoStartDe(outcome.plano, 3)).toBe(true)
    expect(outcome.avisos ?? []).toHaveLength(1)
  })

  it('plano com tarefa única e auto_start=false → cabeça corrigida + aviso', () => {
    const outcome = comoPlano(planoJson([
      { seq: 1, depende_de: [], auto_start: false },
    ]))

    expect(autoStartDe(outcome.plano, 1)).toBe(true)
    expect(outcome.avisos ?? []).toHaveLength(1)
  })

  it('cabeça é a MENOR seq independentemente da ordem do array', () => {
    const outcome = comoPlano(planoJson([
      { seq: 2, depende_de: [1], auto_start: false },
      { seq: 1, depende_de: [], auto_start: false },
    ]))

    expect(autoStartDe(outcome.plano, 1)).toBe(true)
    expect(autoStartDe(outcome.plano, 2)).toBe(false)
    const avisos = outcome.avisos ?? []
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('seq 1')
  })

  it('avisos ficam FORA do JSON do plano (contrato §5: apenas campos do contrato)', () => {
    const outcome = comoPlano(planoJson([
      { seq: 1, depende_de: [], auto_start: false },
    ]))

    expect(outcome.plano).not.toHaveProperty('avisos')
    expect(JSON.stringify(outcome.plano)).not.toContain('avisos')
    // Demais campos do contrato permanecem intactos após a normalização.
    expect(outcome.plano.kind).toBe('plano')
    expect(outcome.plano.tarefas).toHaveLength(1)
    expect(outcome.plano.matrizCobertura).toHaveLength(1)
  })

  it('seqs não sequenciais a partir de 2 → cabeça é a menor (seq 2), corrigida', () => {
    const content = JSON.stringify({
      ...JSON.parse(planoJson([
        { seq: 2, depende_de: [], auto_start: false },
        { seq: 5, depende_de: [2], auto_start: false },
      ])),
      requisitos: [
        { id: 'REQ-F-002', texto: 'R2.', origem: 'captura', classificacao: 'crud' },
        { id: 'REQ-F-005', texto: 'R5.', origem: 'captura', classificacao: 'crud' },
      ],
      tarefas: [
        { seq: 2, titulo: 'T2', objetivo: 'O2', escopo: 'E2', aceite: ['A2'], requisitos: ['REQ-F-002'], executor: 'biblioteca-global', depende_de: [], auto_start: false, risco: 'medio' },
        { seq: 5, titulo: 'T5', objetivo: 'O5', escopo: 'E5', aceite: ['A5'], requisitos: ['REQ-F-005'], executor: 'biblioteca-global', depende_de: [2], auto_start: false, risco: 'medio' },
      ],
      matrizCobertura: [
        { req: 'REQ-F-002', cobertoPor: 'tarefa:2' },
        { req: 'REQ-F-005', cobertoPor: 'tarefa:5' },
      ],
    })

    const outcome = comoPlano(content)
    expect(autoStartDe(outcome.plano, 2)).toBe(true)
    expect(autoStartDe(outcome.plano, 5)).toBe(false)
    expect(outcome.avisos ?? []).toHaveLength(1)
    expect((outcome.avisos ?? [])[0]).toContain('seq 2')
  })
})
