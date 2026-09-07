export interface PromptPart {
  source: "system" | "table" | "contract" | "context"
  label: string
  text: string
}

export interface ComposedPrompt {
  finalText: string
  parts: PromptPart[]
}

export function workspaceSystemGuard(workspace: string, gitRoot: string): string {
  return [
    "REGRA DE SEGURANÇA DO MOTOR (não editável pelo catálogo):",
    `Diretório obrigatório do projeto (resultado esperado de pwd): ${workspace}`,
    `Raiz Git esperada (resultado esperado de git rev-parse --show-toplevel): ${gitRoot}`,
    "Antes de trabalhar, execute pwd, git rev-parse --show-toplevel e git branch --show-current e compare cada resultado com o caminho correspondente acima.",
    "Execute os comandos Git a partir do diretório do projeto. A raiz Git pode ser o worktree pai do projeto; esses caminhos não precisam ser iguais.",
    "Não leia, altere ou teste arquivos fora do diretório do projeto. Se alguma validação correspondente falhar, responda blocked_environment.",
    "Não faça commit; o Motor fará o commit após validar a entrega.",
  ].join("\n")
}

export function workspaceSystemClosing(workspace: string, gitRoot: string): string {
  return [
    "VERIFICAÇÃO DE SEGURANÇA DO MOTOR:",
    `Confirme pwd = ${workspace}.`,
    `Confirme git rev-parse --show-toplevel = ${gitRoot}.`,
    "Execute git status --short a partir do diretório do projeto antes da resposta final.",
  ].join("\n")
}

export function composeDevelopmentPrompt(workspace: string, gitRoot: string, tableText: string): ComposedPrompt {
  const parts: PromptPart[] = [
    { source: "system", label: "Segurança do workspace", text: workspaceSystemGuard(workspace, gitRoot) },
    { source: "table", label: "Prompt publicado na tabela", text: tableText },
    { source: "system", label: "Verificação final", text: workspaceSystemClosing(workspace, gitRoot) },
  ]
  return { parts, finalText: parts.map((part) => part.text).filter(Boolean).join("\n\n") }
}
