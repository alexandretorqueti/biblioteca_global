/**
 * ProjectIdValidationPolicy - Validação de projeto_id na criação de tarefas
 * 
 * Regra: toda tarefa deve referenciar uma linha existente de
 * projetos_captados e, para execução, essa linha deve ter agente vinculado.
 * 
 * O projeto do token da Biblioteca e o projeto gerenciado são namespaces
 * distintos. No Motor, a FK persistida é a fonte canônica do projeto a executar.
 */

export interface ProjectIdValidationResult {
  ok: boolean
  reason?: string
  /** projeto_captados.id válido (quando encontrado) */
  projetoCaptadoId?: number
  /** Slug do projeto (para diagnóstico) */
  projectSlug?: string
  /** Agente vinculado ao projeto (para diagnóstico) */
  agentId?: string
}

/**
 * Valida se o projeto_id fornecido refere-se a uma linha válida de projetos_captados.
 * 
 * Regras:
 * - projeto_id deve existir em projetos_captados
 * - projeto_captado deve ter agente_id vinculado (para tarefas de execução)
 * 
 * @param projetoId - ID numérico a validar
 * @param context - Contexto da validação (quem está chamando, para qual projeto)
 * @param lookupFn - Função que busca projetos_captados por ID (injetável para testes)
 * @returns Resultado da validação com diagnóstico
 */
export async function validateProjectId(
  projetoId: number,
  context: {
    /** Tipo de tarefa: 'setup' (biblioteca executa) ou 'execution' (agente do projeto executa) */
    taskType: 'setup' | 'execution'
    /** Slug do projeto esperado (para validação cruzada) */
    expectedSlug?: string
  },
  lookupFn: (id: number) => Promise<{
    id: number
    slug: string
    agenteId: number | null
    agenteOpenclawId: string | null
    agenteNome: string | null
  } | null>,
): Promise<ProjectIdValidationResult> {
  if (!Number.isSafeInteger(projetoId) || projetoId <= 0) {
    return {
      ok: false,
      reason: `projeto_id=${String(projetoId)} inválido: informe um id numérico positivo de projetos_captados.`,
    }
  }
  // Regra 1: projeto_id deve existir
  const projeto = await lookupFn(projetoId)
  if (!projeto) {
    return {
      ok: false,
      reason: `projeto_id=${projetoId} não encontrado em projetos_captados. ` +
              `Verifique se o projeto foi registrado corretamente.`,
    }
  }

  // Comparação opcional somente quando o chamador possui uma fonte realmente
  // independente para o slug esperado. O TaskCoordinator não passa o slug
  // obtido do mesmo JOIN, pois isso seria uma validação circular.
  if (context.expectedSlug && context.expectedSlug !== projeto.slug) {
    return {
      ok: false,
      reason: `projeto_id=${projetoId} refere-se ao projeto "${projeto.slug}", ` +
              `mas a tarefa espera o projeto "${context.expectedSlug}". ` +
              `projeto_id incorreto para este projeto.`,
    }
  }

  // Para tarefas de execução, projeto deve ter agente vinculado.
  if (context.taskType === 'execution' && !projeto.agenteId) {
    return {
      ok: false,
      reason: `projeto_id=${projetoId} (slug="${projeto.slug}") não tem agente vinculado (agente_id nulo). ` +
              `Tarefas de execução exigem agente configurado em projetos_captados.`,
    }
  }

  return {
    ok: true,
    projetoCaptadoId: projeto.id,
    projectSlug: projeto.slug,
    agentId: projeto.agenteOpenclawId ?? projeto.agenteNome ?? undefined,
  }
}

/**
 * Valida projeto_id de forma síncrona (para uso em gates sem acesso ao banco).
 * Versão simplificada que valida apenas regras estruturais.
 * 
 * @param projetoId - ID numérico a validar
 * @param knownProjectIds - Lista de IDs válidos conhecidos
 * @param bibliotecaProjectId - Mantido por compatibilidade; não define o tenant
 * @param context - Contexto da validação
 */
export function validateProjectIdSync(
  projetoId: number,
  knownProjectIds: number[],
  _bibliotecaProjectId: number,
  _context: {
    taskType: 'setup' | 'execution'
    expectedSlug?: string
  },
): ProjectIdValidationResult {
  void _bibliotecaProjectId
  void _context
  if (!Number.isSafeInteger(projetoId) || projetoId <= 0) {
    return {
      ok: false,
      reason: `projeto_id=${String(projetoId)} inválido: informe um id numérico positivo de projetos_captados.`,
    }
  }
  // Regra 1: projeto_id deve estar na lista de conhecidos
  if (!knownProjectIds.includes(projetoId)) {
    return {
      ok: false,
      reason: `projeto_id=${projetoId} não encontrado entre os projetos conhecidos. ` +
              `Projetos válidos: ${knownProjectIds.join(', ')}.`,
    }
  }

  return { ok: true, projetoCaptadoId: projetoId }
}

/**
 * Formata relatório de validação de projeto_id para log/erro.
 */
export function formatProjectIdValidationReport(result: ProjectIdValidationResult): string {
  if (result.ok) {
    const parts = ['✅ projeto_id válido']
    if (result.projectSlug) parts.push(`slug="${result.projectSlug}"`)
    if (result.agentId) parts.push(`agente="${result.agentId}"`)
    return parts.join(' | ')
  }

  return `❌ projeto_id inválido: ${result.reason}`
}
