/** Contexto determinístico entre subtarefas; Git é a fonte de verdade. */
export type HandoffFile = { status: "A" | "M" | "D" | "R"; path: string }
export type PriorSubtaskHandoff = { seq: number; title: string; commit: string; files: readonly HandoffFile[]; summary?: string | null }

const safePath = (value: string): boolean => value.length > 0 && !value.includes("\0") && !value.startsWith("/") && !value.split("/").includes("..")

export function parseGitNameStatus(output: string): HandoffFile[] {
  const seen = new Set<string>()
  const files: HandoffFile[] = []
  for (const line of output.split("\n")) {
    const [rawStatus, ...rest] = line.split("\t")
    const status = rawStatus?.charAt(0)
    const path = rest.at(-1)?.trim() ?? ""
    if (!status || !["A", "M", "D", "R"].includes(status) || !safePath(path) || seen.has(path)) continue
    seen.add(path)
    files.push({ status: status as HandoffFile["status"], path })
  }
  return files
}

export function formatPriorSubtaskHandoff(items: readonly PriorSubtaskHandoff[]): string {
  if (items.length === 0) return ""
  const lines = ["CONTEXTO CONFIRMADO DE SUBTAREFAS ANTERIORES", "Os arquivos abaixo foram obtidos do Git. Leia os que forem relevantes; não contradiga decisões anteriores sem justificar."]
  for (const item of items) {
    lines.push("", `Subtarefa #${item.seq} — ${item.title} (commit ${item.commit.slice(0, 12)})`)
    if (item.summary) lines.push(`Resumo do executor: ${item.summary.slice(0, 500)}`)
    if (item.files.length === 0) lines.push("Arquivos rastreados: nenhum identificado.")
    else for (const file of item.files.slice(0, 30)) lines.push(`- [${file.status}] ${file.path}`)
  }
  return lines.join("\n")
}
