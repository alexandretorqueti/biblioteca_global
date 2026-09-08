import type { TaskFinalResult, TaskTipo } from "../shared/types/infrastructure.js"

export interface FinalResultSubtask { seq: number; titulo: string; resultado?: string | null }
const STATUSES = ["done", "need_help", "blocked_environment"] as const

function parseResult(text: string | null | undefined): TaskFinalResult {
  if (!text?.trim()) return { status: "done", summary: "Execução concluída sem detalhes adicionais.", reason: "" }
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const value = JSON.parse(match[0]) as Record<string, unknown>
      if (STATUSES.includes(value.status as typeof STATUSES[number])) return {
        status: value.status as TaskFinalResult["status"],
        summary: typeof value.summary === "string" ? value.summary.trim() : "",
        reason: typeof value.reason === "string" ? value.reason.trim() : "",
      }
    } catch { /* resposta textual legada */ }
  }
  return { status: "done", summary: text.trim(), reason: "" }
}

export function consolidateTaskFinalResult(tipo: TaskTipo | undefined, subtasks: FinalResultSubtask[]): TaskFinalResult | null {
  if (tipo !== "automacao" && tipo !== "verificacao") return null
  const results = subtasks.map((subtask) => ({ subtask, result: parseResult(subtask.resultado) }))
  const status = results.some(({ result }) => result.status === "blocked_environment") ? "blocked_environment"
    : results.some(({ result }) => result.status === "need_help") ? "need_help" : "done"
  const summary = results.map(({ subtask, result }) => `Subtarefa ${subtask.seq} — ${subtask.titulo}: ${result.summary || "Sem resumo informado."}`).join("\n")
    || "Tarefa concluída sem subtarefas com resposta."
  const reason = results.map(({ subtask, result }) => result.reason ? `Subtarefa ${subtask.seq}: ${result.reason}` : "").filter(Boolean).join("\n")
  return { status, summary, reason }
}

export function finalResultChatText(result: TaskFinalResult): string {
  return result.reason ? `${result.summary}\n\nMotivo: ${result.reason}` : result.summary
}
