import { describe, expect, it } from "vitest"
import {
  orphanBlockedSubtaskSql,
  resolveTaskLevelSystemBlockersSql,
  staleBlockerSweepSql,
  systemBlockedSubtaskSql,
  tarefaConcluidaSql,
} from "../src/policies/BlockerSweepQueries.js"

/**
 * As varreduras do pump são a parte que "ensina o motor a pescar": elas só
 * podem tocar em estado que ninguém mais resolveria. Estes testes travam os
 * recortes (e o que eles deliberadamente NÃO incluem).
 */
describe("BlockerSweepQueries", () => {
  it("só considera tarefa concluída quando está na base E deployada E sem subtarefa pendente", () => {
    const sql = tarefaConcluidaSql("t")
    expect(sql).toContain("f.tarefa_id = t.id AND f.integration_confirmed_at IS NOT NULL")
    expect(sql).toContain("d.tarefa_id = t.id AND d.status = 'succeeded'")
    expect(sql).toContain("s.status NOT IN ('verified', 'superseded')")
    expect(sql).toContain(" AND ")
  })

  it("higiene cobre as duas famílias: promoção em tarefa integrada/deployada e bloqueio em tarefa concluída", () => {
    const sql = staleBlockerSweepSql()
    expect(sql).toContain("b.resolved_at IS NULL")
    expect(sql).toContain("motor-v2:promotion-conflict:")
    expect(sql).toContain("motor-v2:repositório principal não está limpo:")
    expect(sql).toContain("OR (EXISTS (SELECT 1 FROM task_runtime_facts")
    expect(sql).toContain("LIMIT 50")
  })

  it("retomada por falha do motor/ambiente exige causa de sistema, carência e tarefa não concluída", () => {
    const sql = systemBlockedSubtaskSql()
    expect(sql).toContain("s.status = 'blocked'")
    expect(sql).toContain("b.block_reason IN ('blocked_environment', 'systemic_failure', 'model_chain_exhausted')")
    expect(sql).toContain("INTERVAL 90 SECOND")
    expect(sql).toContain("f.integration_confirmed_at IS NULL")
    expect(sql).toContain("f.terminal_status IS NULL")
    expect(sql).toContain("0 AS orphan")
    // não retoma se a causa é promoção (fluxo próprio) nem com execução ativa
    expect(sql).toContain("motor-v2:promotion-conflict:")
    expect(sql).toContain("motor_active_executions")
  })

  it("estado órfão (blocked sem bloqueio aberto) só entra sem bloqueio algum na tarefa", () => {
    const sql = orphanBlockedSubtaskSql()
    expect(sql).toContain("s.status = 'blocked'")
    expect(sql).toContain("b.subtarefa_id = s.id AND b.resolved_at IS NULL")
    expect(sql).toContain("b3.tarefa_id = t.id AND b3.resolved_at IS NULL")
    expect(sql).toContain("1 AS orphan")
    expect(sql).toContain("INTERVAL 90 SECOND")
  })

  it("resolve o bloqueio espelhado no nível da tarefa ao retomar a subtarefa", () => {
    const sql = resolveTaskLevelSystemBlockersSql()
    expect(sql).toContain("UPDATE bloqueios")
    expect(sql).toContain("b.subtarefa_id IS NULL")
    expect(sql).toContain("b.tarefa_id = ?")
    expect(sql).toContain("b.block_reason IN ('blocked_environment', 'systemic_failure', 'model_chain_exhausted')")
    // nunca mexe em bloqueio de promoção (fluxo próprio tem orquestração)
    expect(sql).toContain("motor-v2:promotion-conflict:")
    expect(sql).toContain(" AND NOT ")
  })

  it("nenhuma varredura lê coluna inexistente de tarefas (status)", () => {
    for (const sql of [staleBlockerSweepSql(), systemBlockedSubtaskSql(), orphanBlockedSubtaskSql()]) {
      expect(sql).not.toMatch(/t\.status/)
      expect(sql).not.toMatch(/tarefas\.status/)
    }
  })
})
