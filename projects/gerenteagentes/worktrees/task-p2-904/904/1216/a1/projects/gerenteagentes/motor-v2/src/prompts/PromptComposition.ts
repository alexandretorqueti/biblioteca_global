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

export function workspaceSystemClosing(): string {
  return [
    "VERIFICAÇÃO DE SEGURANÇA DO MOTOR:",
    "Antes da resposta final, execute git status --short a partir do diretório do projeto.",
    "Responda somente com o JSON do contrato do Motor; mensagens humanas de progresso pertencem ao chat da tarefa.",
  ].join("\n")
}

export function composeDevelopmentPrompt(workspace: string, gitRoot: string, tableText: string): ComposedPrompt {
  const executionInstructions = [
    "FLUXO DE EXECUÇÃO OBRIGATÓRIO (use as ferramentas para REALMENTE fazer as alterações):",
    "1. Leia os arquivos relevantes usando a ferramenta 'read'",
    "2. Faça as alterações necessárias usando as ferramentas 'edit' (para modificar) ou 'write' (para criar)",
    "3. Execute os comandos de build/teste usando a ferramenta 'exec'",
    "4. Verifique git status --short para confirmar as alterações",
    "5. Só então gere o JSON de conclusão do contrato",
    "",
    "IMPORTANTE: NÃO gere o JSON de conclusão sem antes ter feito as alterações REAIS com as ferramentas.",
    "O Motor verifica git diff — se não houver alterações reais, a entrega será rejeitada.",
  ].join("\n")

  const parts: PromptPart[] = [
    { source: "system", label: "Segurança do workspace", text: workspaceSystemGuard(workspace, gitRoot) },
    { source: "system", label: "Instruções de execução", text: executionInstructions },
    { source: "table", label: "Prompt publicado na tabela", text: tableText },
    { source: "system", label: "Verificação final", text: workspaceSystemClosing() },
  ]
  return { parts, finalText: parts.map((part) => part.text).filter(Boolean).join("\n\n") }
}
