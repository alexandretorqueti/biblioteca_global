export interface PromptPart {
  source: "system" | "table" | "contract" | "context"
  label: string
  text: string
}

export interface ComposedPrompt {
  finalText: string
  parts: PromptPart[]
}

export function workspaceSystemGuard(workspace: string): string {
  return [
    "REGRA DE SEGURANÇA DO MOTOR (não editável pelo catálogo):",
    `Workspace obrigatório: ${workspace}`,
    "Antes de trabalhar, execute pwd, git rev-parse --show-toplevel e git branch --show-current.",
    "Não leia, altere, teste ou execute Git fora desse workspace. Se a validação falhar, responda blocked_environment.",
    "Não faça commit; o Motor fará o commit após validar a entrega.",
  ].join("\n")
}

export function workspaceSystemClosing(workspace: string): string {
  return [
    "VERIFICAÇÃO DE SEGURANÇA DO MOTOR:",
    `Confirme pwd = ${workspace} e execute git status --short antes da resposta final.`,
  ].join("\n")
}

export function composeDevelopmentPrompt(workspace: string, tableText: string): ComposedPrompt {
  const parts: PromptPart[] = [
    { source: "system", label: "Segurança do workspace", text: workspaceSystemGuard(workspace) },
    { source: "table", label: "Prompt publicado na tabela", text: tableText },
    { source: "system", label: "Verificação final", text: workspaceSystemClosing(workspace) },
  ]
  return { parts, finalText: parts.map((part) => part.text).filter(Boolean).join("\n\n") }
}
