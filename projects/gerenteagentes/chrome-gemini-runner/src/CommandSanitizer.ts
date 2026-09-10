/**
 * Sanitizador de comandos — bloqueia operações perigosas
 */

const DANGEROUS_PATTERNS = [
  // Destruição em massa
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/\s*$/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/\*/,
  /\bmkfs\./,
  /\bdd\s+.*of=\/dev\//,
  
  // Pipes perigosos
  /\|\s*sh\b/,
  /\|\s*bash\b/,
  /\|\s*zsh\b/,
  /\|\s*sudo\b/,
  
  // Sudo e privilégios
  /\bsudo\b/,
  /\bsu\s+root\b/,
  /\bchmod\s+777\b/,
  
  // Download e execução remota
  /\bcurl\b.*\|\s*(sh|bash)/,
  /\bwget\b.*\|\s*(sh|bash)/,
  
  // Variáveis de ambiente sensíveis
  /\benv\b/,
  /\bprintenv\b/,
  /\bexport\s+(AWS_|GOOGLE_|AZURE_)/,
  
  // Rede (pode vazar dados)
  /\bnc\s+-/,
  /\bncat\b/,
  /\bsocat\b/,
  
  // Processos críticos
  /\bkill\s+-9\s+1\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
];

const ALLOWED_COMMANDS = [
  'ls', 'cat', 'grep', 'find', 'echo', 'mkdir', 'cp', 'mv', 'rm',
  'git', 'npm', 'node', 'npx', 'yarn', 'pnpm',
  'pwd', 'cd', 'head', 'tail', 'wc', 'sort', 'uniq',
  'touch', 'chmod', 'chown',
  'test', '[', '[[',
];

export class CommandSanitizer {
  /**
   * Verifica se um comando é seguro para execução
   * @returns { safe: boolean, reason?: string }
   */
  sanitize(command: string): { safe: boolean; reason?: string } {
    const trimmed = command.trim();
    
    // Comando vazio
    if (!trimmed) {
      return { safe: false, reason: 'Comando vazio' };
    }
    
    // Verifica padrões perigosos
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { 
          safe: false, 
          reason: `Comando bloqueado por padrão de segurança: ${pattern.source}` 
        };
      }
    }
    
    // Extrai o comando base (primeira palavra)
    const baseCommand = trimmed.split(/\s+/)[0];
    
    // Remove prefixos comuns (time, env, etc.)
    const cleanBase = baseCommand.replace(/^(time|env|nohup)\s+/, '');
    
    // Verifica se está na allowlist (comando base)
    const isAllowed = ALLOWED_COMMANDS.some(cmd => 
      cleanBase === cmd || cleanBase.endsWith('/' + cmd)
    );
    
    if (!isAllowed) {
      return { 
        safe: false, 
        reason: `Comando '${cleanBase}' não está na allowlist` 
      };
    }
    
    return { safe: true };
  }

  /**
   * Extrai o comando de um bloco de código markdown
   * @param codeBlock Bloco de código (com ou sem ```)
   */
  extractCommand(codeBlock: string): string {
    // Remove markdown code fences
    let command = codeBlock
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```$/m, '')
      .trim();
    
    // Pega só a primeira linha (um comando por vez)
    const firstLine = command.split('\n')[0].trim();
    
    return firstLine;
  }
}
