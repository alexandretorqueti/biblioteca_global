import { describe, expect, it } from "vitest"
import { transitionTask } from "../src/policies/TaskStateMachine.js"

/**
 * Testes das ações de decisão sobre o plano:
 * - Aprovar e iniciar (approve_plan)
 * - Solicitar ajustes (request_adjustments)
 * - Continuar conversando (continue_conversation)
 *
 * Critérios de aceite:
 * - Cada decisão altera o estado de forma válida e auditável
 * - Aprovar e iniciar exige ação explícita (só funciona em awaiting_approval)
 * - Solicitar ajustes volta para planned (reanálise na mesma sessão)
 * - Continuar conversando volta para awaiting_clarification → planned (diálogo sem rejeitar)
 */

describe("Plan Decision Actions — State Transitions", () => {
  // ==========================================================================
  // Aprovar e iniciar
  // ==========================================================================

  describe("Aprovar e iniciar (approve_plan)", () => {
    it("transita de awaiting_approval para ready", () => {
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })

    it("não permite aprovar fora de awaiting_approval", () => {
      expect(() => transitionTask("planned", "approve_plan")).toThrow()
      expect(() => transitionTask("analyzing", "approve_plan")).toThrow()
      expect(() => transitionTask("awaiting_clarification", "approve_plan")).toThrow()
      expect(() => transitionTask("running", "approve_plan")).toThrow()
      expect(() => transitionTask("ready", "approve_plan")).toThrow()
    })

    it("após aprovação, tarefa está pronta para execução (ready)", () => {
      const nextStatus = transitionTask("awaiting_approval", "approve_plan")
      expect(nextStatus).toBe("ready")
      // ready permite start_execution
      expect(transitionTask(nextStatus, "start_execution")).toBe("running")
    })
  })

  // ==========================================================================
  // Solicitar ajustes
  // ==========================================================================

  describe("Solicitar ajustes (request_adjustments)", () => {
    it("transita de awaiting_approval para planned (reanálise na mesma sessão)", () => {
      expect(transitionTask("awaiting_approval", "request_adjustments")).toBe("planned")
    })

    it("não permite solicitar ajustes fora de awaiting_approval", () => {
      expect(() => transitionTask("planned", "request_adjustments")).toThrow()
      expect(() => transitionTask("analyzing", "request_adjustments")).toThrow()
      expect(() => transitionTask("awaiting_clarification", "request_adjustments")).toThrow()
      expect(() => transitionTask("running", "request_adjustments")).toThrow()
    })

    it("após solicitar ajustes, tarefa volta para planned e pode ser reanalisada", () => {
      const nextStatus = transitionTask("awaiting_approval", "request_adjustments")
      expect(nextStatus).toBe("planned")
      // planned permite start_analysis
      expect(transitionTask(nextStatus, "start_analysis")).toBe("analyzing")
    })
  })

  // ==========================================================================
  // Continuar conversando
  // ==========================================================================

  describe("Continuar conversando (continue_conversation)", () => {
    it("transita de awaiting_approval para awaiting_clarification", () => {
      expect(transitionTask("awaiting_approval", "continue_conversation")).toBe("awaiting_clarification")
    })

    it("não permite continuar conversando fora de awaiting_approval", () => {
      expect(() => transitionTask("planned", "continue_conversation")).toThrow()
      expect(() => transitionTask("analyzing", "continue_conversation")).toThrow()
      expect(() => transitionTask("awaiting_clarification", "continue_conversation")).toThrow()
      expect(() => transitionTask("running", "continue_conversation")).toThrow()
      expect(() => transitionTask("ready", "continue_conversation")).toThrow()
    })

    it("após continuar conversando, a resposta devolve para planned (mesmo fluxo de clarificação)", () => {
      const afterContinue = transitionTask("awaiting_approval", "continue_conversation")
      expect(afterContinue).toBe("awaiting_clarification")
      // Resposta do analista/devolve para planned
      const afterAnswer = transitionTask(afterContinue, "clarification_answered")
      expect(afterAnswer).toBe("planned")
    })

    it("fluxo completo: awaiting_approval → continuar → resposta → planned → análise", () => {
      // 1. Dono continua conversando sobre a proposta
      const afterContinue = transitionTask("awaiting_approval", "continue_conversation")
      expect(afterContinue).toBe("awaiting_clarification")

      // 2. Analista responde (ou pump concilia) → volta para planned
      const afterAnswer = transitionTask(afterContinue, "clarification_answered")
      expect(afterAnswer).toBe("planned")

      // 3. Pump seleciona e inicia análise na mesma sessão
      const analyzing = transitionTask(afterAnswer, "start_analysis")
      expect(analyzing).toBe("analyzing")

      // 4. Analista apresenta nova proposta (ou confirma a anterior)
      const proposing = transitionTask(analyzing, "propose_plan")
      expect(proposing).toBe("awaiting_approval")
    })
  })

  // ==========================================================================
  // Fluxo completo de decisões
  // ==========================================================================

  describe("Fluxo completo de decisões sobre o plano", () => {
    it("aprovação direta: analyzing → propose → approve → ready → running", () => {
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
      expect(transitionTask("ready", "start_execution")).toBe("running")
    })

    it("ajustes antes de aprovar: propose → adjust → reanalyze → propose → approve", () => {
      // Primeira proposta
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Dono pede ajustes
      expect(transitionTask("awaiting_approval", "request_adjustments")).toBe("planned")

      // Reanálise na mesma sessão
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")

      // Nova proposta
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Aprovação
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })

    it("conversa antes de aprovar: propose → continue → answer → reanalyze → approve", () => {
      // Proposta inicial
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Dono quer entender melhor a proposta (continuar conversando)
      expect(transitionTask("awaiting_approval", "continue_conversation")).toBe("awaiting_clarification")

      // Analista responde → volta para planned
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")

      // Reanálise na mesma sessão
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")

      // Analista apresenta proposta atualizada
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Agora o dono aprova
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })

    it("múltiplas rodadas de conversa: propose → continue → continue → answer → approve", () => {
      // Proposta
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Primeira rodada de conversa
      expect(transitionTask("awaiting_approval", "continue_conversation")).toBe("awaiting_clarification")
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Segunda rodada de conversa
      expect(transitionTask("awaiting_approval", "continue_conversation")).toBe("awaiting_clarification")
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")

      // Aprovação final
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })
  })

  // ==========================================================================
  // Cancelamento e falha durante estados de decisão
  // ==========================================================================

  describe("Cancelamento e falha durante estados de decisão", () => {
    it("tarefa awaiting_approval pode ser cancelada", () => {
      expect(transitionTask("awaiting_approval", "cancel")).toBe("cancelled")
    })

    it("tarefa awaiting_approval pode ser bloqueada por falha", () => {
      expect(transitionTask("awaiting_approval", "fail")).toBe("blocked")
    })

    it("tarefa awaiting_approval NÃO pode ser pausada (decisão pendente exige ação explícita)", () => {
      expect(() => transitionTask("awaiting_approval", "pause")).toThrow()
    })
  })
})
