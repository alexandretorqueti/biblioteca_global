/**
 * Normaliza conteúdo de mensagens do chat para exibição humana.
 *
 * O analista pode retornar:
 * - Texto simples (string)
 * - JSON estruturado (string JSON ou objeto)
 * - Blocos de conteúdo do Console (array de blocos)
 *
 * Esta função converte qualquer formato em texto legível, sem expor
 * JSON bruto, envelopes técnicos ou `[object Object]`.
 */

/**
 * Tenta converter conteúdo estruturado em texto legível.
 *
 * @param content - Conteúdo da mensagem (string, objeto, array ou unknown)
 * @returns Texto normalizado para exibição
 */
export function normalizeChatContent(content: unknown): string {
  // Caso 1: string vazia ou null/undefined
  if (content == null) return '';

  // Caso 2: já é string
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return '';

    // Tenta parsear como JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return formatStructuredContent(parsed);
      } catch {
        // Não é JSON válido, retorna como texto
        return trimmed;
      }
    }

    return trimmed;
  }

  // Caso 3: objeto ou array
  if (typeof content === 'object') {
    return formatStructuredContent(content);
  }

  // Caso 4: outros tipos (number, boolean, etc)
  return String(content);
}

/**
 * Formata conteúdo estruturado (JSON parseado) em texto legível.
 */
function formatStructuredContent(data: unknown): string {
  if (data == null) return '';

  // Array de blocos de conteúdo (formato do Console/OpenClaw)
  if (Array.isArray(data)) {
    return data
      .map(block => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block !== null) {
          // Bloco de texto
          if ('type' in block && block.type === 'text' && 'text' in block) {
            return String(block.text);
          }
          // Bloco de tool use/result
          if ('type' in block && (block.type === 'tool_use' || block.type === 'tool_result')) {
            return ''; // Omite blocos técnicos
          }
          // Outro tipo de bloco
          return '';
        }
        return String(block);
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  // Objeto com estrutura de análise do analista
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // Formato de perguntas (clarification)
    if (obj.kind === 'perguntas' || Array.isArray(obj.perguntas)) {
      const perguntas = Array.isArray(obj.perguntas)
        ? obj.perguntas.map(p => String(p).trim()).filter(Boolean)
        : [];

      if (perguntas.length === 0) {
        return 'O analista precisa de esclarecimentos.';
      }

      const linhas: string[] = ['🤔 O analista precisa de esclarecimentos:', ''];

      if (typeof obj.resumo === 'string' && obj.resumo.trim()) {
        linhas.push('Entendimento atual: ' + obj.resumo.trim(), '');
      }

      perguntas.forEach((pergunta, index) => {
        linhas.push(`${index + 1}) ${pergunta}`);
      });

      linhas.push('', 'Responda neste chat para continuar (ex.: "1: resposta; 2: resposta").');

      return linhas.join('\n');
    }

    // Formato de plano de subtarefas
    if (Array.isArray(obj.subtarefas)) {
      const subtarefas = obj.subtarefas as Array<Record<string, unknown>>;
      if (subtarefas.length === 0) {
        return 'O analista gerou um plano vazio.';
      }

      const linhas: string[] = ['📋 Plano de execução gerado:', ''];

      subtarefas.forEach((sub, index) => {
        const titulo = typeof sub.titulo === 'string' ? sub.titulo : `Subtarefa ${index + 1}`;
        const scope = typeof sub.scope === 'string' ? sub.scope : '';

        linhas.push(`**${index + 1}. ${titulo}**`);
        if (scope) {
          linhas.push(scope);
        }

        if (Array.isArray(sub.acceptance_criteria)) {
          linhas.push('Critérios de aceite:');
          sub.acceptance_criteria.forEach((criterio: unknown) => {
            linhas.push(`  • ${String(criterio)}`);
          });
        }

        linhas.push('');
      });

      return linhas.join('\n').trim();
    }

    // Objeto genérico: formata como chave-valor legível
    return Object.entries(obj)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        const formattedValue = typeof value === 'object'
          ? JSON.stringify(value, null, 2)
          : String(value);
        return `${label}: ${formattedValue}`;
      })
      .join('\n');
  }

  return '';
}
