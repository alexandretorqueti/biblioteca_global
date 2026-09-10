/**
 * PromptBuilder — monta os prompts para as IAs
 */

export class PromptBuilder {
  /**
   * Monta o prompt de resultado (feedback do comando executado)
   */
  buildResultPrompt(
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number
  ): string {
    const output = stdout || stderr || '(sem saída)';
    const truncated = output.length > 4000 
      ? output.substring(0, 4000) + '\n... [TRUNCADO]'
      : output;
    
    return `Comando executado:
\`\`\`
${command}
\`\`\`

Saída (exit code: ${exitCode}):
\`\`\`
${truncated}
\`\`\`

Continue com o próximo comando.`;
  }
}
