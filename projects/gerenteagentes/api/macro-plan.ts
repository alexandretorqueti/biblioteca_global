/**
 * Plano da Geração Macro — validação e materialização de texto (API).
 *
 * Espelho das regras do contrato §5 de docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md
 * (parser canônico: motor-v3/src/generation/GenerationPlanContract.ts). A API
 * NÃO importa o motor-v3 (build/moduleResolution distintos); este módulo
 * re-valida o plano persistido em geracoes_projeto.tasks e o planoEditado
 * enviado na aprovação com as MESMAS regras do contrato, para que:
 * - a materialização (§4) trabalhe apenas com plano normalizado;
 * - edições humanas inválidas sejam rejeitadas com 422 antes de qualquer insert.
 *
 * Regras de tolerância idênticas ao parser do motor: lacunas/lacunasBiblioteca/
 * riscos/foraDeFase ausentes → []; demais campos são obrigatórios.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON de contrato é dinâmico;
 * mesmo padrão do parser canônico motor-v3/src/generation/GenerationPlanContract.ts */

export class PlanoMacroInvalidoError extends Error {
  constructor(message: string) {
    super(`plano_invalido: ${message}`);
    this.name = 'PlanoMacroInvalidoError';
  }
}

export interface MacroRequisitoPlano {
  id: string;
  texto: string;
  origem: string;
  classificacao: 'crud' | 'custom' | 'lacuna';
}

export interface MacroEntidadePlano {
  nome: string;
  campos: string[];
  mascarasValidacoes: string[];
  menu?: string;
}

export interface MacroTarefaPlano {
  seq: number;
  titulo: string;
  objetivo: string;
  escopo: string;
  aceite: string[];
  requisitos: string[];
  executor: 'biblioteca-global' | 'agente-projeto';
  depende_de: number[];
  auto_start: boolean;
  risco: 'baixo' | 'medio' | 'alto';
}

export interface MacroCoberturaPlano {
  req: string;
  cobertoPor: string;
  justificativa?: string;
}

export interface MacroLacunaBibliotecaPlano {
  funcionalidade: string;
  req?: string;
  contexto?: string;
}

export interface MacroPlanoValidado {
  kind: 'plano';
  classificacaoSistema: '100% crud' | 'misto' | 'predominantemente custom';
  requerAgenteDedicado: boolean;
  requisitos: MacroRequisitoPlano[];
  especificacaoCrud: { entidades: MacroEntidadePlano[]; observacoes?: string };
  tarefas: MacroTarefaPlano[];
  matrizCobertura: MacroCoberturaPlano[];
  lacunas: string[];
  lacunasBiblioteca: MacroLacunaBibliotecaPlano[];
  riscos: string[];
  foraDeFase: Array<{ req: string; motivo: string }>;
}

const CLASSIFICACOES_SISTEMA = ['100% crud', 'misto', 'predominantemente custom'] as const;
const CLASSIFICACOES_REQ = ['crud', 'custom', 'lacuna'] as const;
const EXECUTORES = ['biblioteca-global', 'agente-projeto'] as const;
const RISCOS = ['baixo', 'medio', 'alto'] as const;
const REQ_ID_PATTERN = /^REQ-[A-Z0-9_-]+$/;

function violation(message: string): never {
  throw new PlanoMacroInvalidoError(message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) violation(`${field} deve ser um array de strings`);
  return value
    .map((item: unknown) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item: string) => item.length > 0);
}

/**
 * Valida e normaliza um plano macro (persistido pelo worker ou editado por
 * humano na aprovação). Lança PlanoMacroInvalidoError em qualquer violação do
 * contrato — inclusive a regra cruzada requerAgenteDedicado=false × tarefas
 * executor='agente-projeto' (§4), que deve resultar em 422 sem criar nada.
 */
export function validarPlanoMacro(value: unknown): MacroPlanoValidado {
  if (!isRecord(value)) violation('plano deve ser um objeto JSON (kind="plano")');
  const parsed = value;
  if (parsed.kind !== 'plano') violation('objeto JSON não é um plano (kind="plano")');

  const classificacaoSistema = CLASSIFICACOES_SISTEMA.find((item) => item === parsed.classificacaoSistema);
  if (!classificacaoSistema) violation(`classificacaoSistema deve ser um de: ${CLASSIFICACOES_SISTEMA.join(' | ')}`);
  if (typeof parsed.requerAgenteDedicado !== 'boolean') violation('requerAgenteDedicado deve ser booleano');

  if (!Array.isArray(parsed.requisitos) || parsed.requisitos.length === 0) violation('requisitos[] é obrigatório (mínimo 1)');
  const requisitos: MacroRequisitoPlano[] = parsed.requisitos.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`requisito ${index + 1} inválido`);
    const id = nonEmptyString(item.id);
    if (!id || !REQ_ID_PATTERN.test(id)) violation(`requisito ${index + 1}: id deve seguir o padrão REQ-* (ex.: REQ-F-001)`);
    const texto = nonEmptyString(item.texto);
    if (!texto) violation(`requisito ${id}: texto é obrigatório`);
    const origem = nonEmptyString(item.origem) ?? '';
    const classificacao = CLASSIFICACOES_REQ.find((entry) => entry === item.classificacao);
    if (!classificacao) violation(`requisito ${id}: classificacao deve ser crud|custom|lacuna`);
    return { id, texto, origem, classificacao };
  });

  if (!isRecord(parsed.especificacaoCrud)) violation('especificacaoCrud é obrigatória (objeto)');
  if (!Array.isArray(parsed.especificacaoCrud.entidades)) violation('especificacaoCrud.entidades[] é obrigatória');
  const entidades: MacroEntidadePlano[] = parsed.especificacaoCrud.entidades.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`entidade ${index + 1} inválida`);
    const nome = nonEmptyString(item.nome);
    if (!nome) violation(`entidade ${index + 1}: nome é obrigatório`);
    const campos = stringArray(item.campos, `entidade ${nome}: campos`);
    if (campos.length === 0) violation(`entidade ${nome}: campos[] não pode ser vazio`);
    const menu = nonEmptyString(item.menu);
    return {
      nome,
      campos,
      mascarasValidacoes: stringArray(item.mascarasValidacoes, `entidade ${nome}: mascarasValidacoes`),
      ...(menu ? { menu } : {}),
    };
  });
  const observacoes = nonEmptyString(parsed.especificacaoCrud.observacoes);
  const especificacaoCrud = { entidades, ...(observacoes ? { observacoes } : {}) };

  if (!Array.isArray(parsed.tarefas) || parsed.tarefas.length === 0) violation('tarefas[] é obrigatório (mínimo 1)');
  const tarefas: MacroTarefaPlano[] = parsed.tarefas.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`tarefa ${index + 1} inválida`);
    const seq = Number(item.seq);
    if (!Number.isInteger(seq) || seq < 1) violation(`tarefa ${index + 1}: seq deve ser inteiro >= 1`);
    const titulo = nonEmptyString(item.titulo);
    if (!titulo) violation(`tarefa ${seq}: titulo é obrigatório`);
    const objetivo = nonEmptyString(item.objetivo);
    if (!objetivo) violation(`tarefa ${seq}: objetivo é obrigatório`);
    const escopo = nonEmptyString(item.escopo);
    if (!escopo) violation(`tarefa ${seq}: escopo é obrigatório`);
    const aceite = stringArray(item.aceite, `tarefa ${seq}: aceite`);
    if (aceite.length === 0) violation(`tarefa ${seq}: aceite[] não pode ser vazio`);
    const requisitosTarefa = stringArray(item.requisitos, `tarefa ${seq}: requisitos`);
    if (requisitosTarefa.length === 0) violation(`tarefa ${seq}: requisitos[] (REQ-* cobertos) não pode ser vazio`);
    const executor = EXECUTORES.find((entry) => entry === item.executor);
    if (!executor) violation(`tarefa ${seq}: executor deve ser biblioteca-global|agente-projeto`);
    if (!Array.isArray(item.depende_de)) violation(`tarefa ${seq}: depende_de[] é obrigatório (pode ser vazio)`);
    const dependeDe = item.depende_de.map((dep: unknown) => Number(dep));
    if (dependeDe.some((dep: number) => !Number.isInteger(dep) || dep < 1)) violation(`tarefa ${seq}: depende_de deve conter inteiros >= 1`);
    if (typeof item.auto_start !== 'boolean') violation(`tarefa ${seq}: auto_start deve ser booleano`);
    const risco = RISCOS.find((entry) => entry === item.risco);
    if (!risco) violation(`tarefa ${seq}: risco deve ser baixo|medio|alto`);
    return { seq, titulo, objetivo, escopo, aceite, requisitos: requisitosTarefa, executor, depende_de: dependeDe, auto_start: item.auto_start, risco };
  });

  // Regras cruzadas do contrato (§5): ordem topológica linear e agente dedicado.
  const seqs = new Set(tarefas.map((tarefa) => tarefa.seq));
  if (seqs.size !== tarefas.length) violation('tarefas com seq duplicado');
  for (const tarefa of tarefas) {
    for (const dep of tarefa.depende_de) {
      if (!seqs.has(dep)) violation(`tarefa ${tarefa.seq}: depende_de referencia seq inexistente (${dep})`);
      if (dep >= tarefa.seq) violation(`tarefa ${tarefa.seq}: depende_de=${dep} quebra a ordem topológica linear (apenas seq anteriores)`);
    }
  }
  if (!parsed.requerAgenteDedicado && tarefas.some((tarefa) => tarefa.executor === 'agente-projeto')) {
    violation('requerAgenteDedicado=false, mas existem tarefas com executor "agente-projeto"');
  }

  if (!Array.isArray(parsed.matrizCobertura) || parsed.matrizCobertura.length === 0) violation('matrizCobertura[] é obrigatória (mínimo 1)');
  const matrizCobertura: MacroCoberturaPlano[] = parsed.matrizCobertura.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`entrada ${index + 1} da matrizCobertura inválida`);
    const req = nonEmptyString(item.req);
    if (!req) violation(`matrizCobertura ${index + 1}: req é obrigatório`);
    const cobertoPor = nonEmptyString(item.cobertoPor);
    if (!cobertoPor) violation(`matrizCobertura ${req}: cobertoPor é obrigatório (tarefa:<seq>|crud:<entidade>|fora_de_fase)`);
    const justificativa = nonEmptyString(item.justificativa);
    return { req, cobertoPor, ...(justificativa ? { justificativa } : {}) };
  });
  const requisitoIds = new Set(requisitos.map((item) => item.id));
  for (const entrada of matrizCobertura) {
    if (!requisitoIds.has(entrada.req)) violation(`matrizCobertura referencia requisito inexistente: ${entrada.req}`);
    const tarefaRef = entrada.cobertoPor.match(/^tarefa:(\d+)$/);
    if (tarefaRef && !seqs.has(Number(tarefaRef[1]))) violation(`matrizCobertura ${entrada.req}: cobertoPor referencia tarefa inexistente (${entrada.cobertoPor})`);
  }
  for (const requisito of requisitos) {
    if (!matrizCobertura.some((entrada) => entrada.req === requisito.id)) {
      violation(`matrizCobertura não cobre o requisito ${requisito.id} (todo requisito deve aparecer na matriz)`);
    }
  }
  for (const tarefa of tarefas) {
    for (const req of tarefa.requisitos) {
      if (!requisitoIds.has(req)) violation(`tarefa ${tarefa.seq}: referencia requisito inexistente (${req})`);
    }
  }

  const lacunasBiblioteca: MacroLacunaBibliotecaPlano[] = (Array.isArray(parsed.lacunasBiblioteca) ? parsed.lacunasBiblioteca : []).map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`lacunasBiblioteca ${index + 1} inválida`);
    const funcionalidade = nonEmptyString(item.funcionalidade);
    if (!funcionalidade) violation(`lacunasBiblioteca ${index + 1}: funcionalidade é obrigatória`);
    const req = nonEmptyString(item.req);
    const contexto = nonEmptyString(item.contexto);
    return { funcionalidade, ...(req ? { req } : {}), ...(contexto ? { contexto } : {}) };
  });
  const foraDeFase = (Array.isArray(parsed.foraDeFase) ? parsed.foraDeFase : []).map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`foraDeFase ${index + 1} inválido`);
    const req = nonEmptyString(item.req);
    const motivo = nonEmptyString(item.motivo);
    if (!req || !motivo) violation(`foraDeFase ${index + 1}: req e motivo são obrigatórios`);
    return { req, motivo };
  });

  return {
    kind: 'plano',
    classificacaoSistema,
    requerAgenteDedicado: parsed.requerAgenteDedicado,
    requisitos,
    especificacaoCrud,
    tarefas,
    matrizCobertura,
    lacunas: stringArray(parsed.lacunas, 'lacunas'),
    lacunasBiblioteca,
    riscos: stringArray(parsed.riscos, 'riscos'),
    foraDeFase,
  };
}

/**
 * Ordem topológica linear do plano (§7 Risco 4): o contrato só permite
 * depende_de referenciando apenas seq anteriores, então ordenar por seq ASC é a
 * ordem topológica. A materialização encadeia cada tarefa à anterior.
 */
export function ordenarTarefasMacro(tarefas: MacroTarefaPlano[]): MacroTarefaPlano[] {
  return [...tarefas].sort((a, b) => a.seq - b.seq);
}

/** external_id idempotente da materialização: macro-<slug>-<n> (n = posição na cadeia, 1-based). */
export function externalIdMacroTarefa(slug: string, posicao: number): string {
  return `macro-${slug}-${posicao}`;
}

export function truncarTexto(valor: string, max: number): string {
  const limpo = valor.trim();
  return limpo.length <= max ? limpo : `${limpo.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Descrição rica da tarefa macro (§4): objetivo, escopo, critérios de aceite,
 * REQ-* cobertos e apontadores para os artefatos do projeto — o analista da
 * tarefa nunca precisa re-inventar intenção a partir de uma frase.
 */
export function montarDescricaoTarefaMacro(contexto: {
  tarefa: MacroTarefaPlano;
  posicao: number;
  total: number;
  slug: string;
  projetoNome: string;
  geracaoId: number;
}): string {
  const { tarefa, posicao, total, slug, projetoNome, geracaoId } = contexto;
  const linhas: string[] = [
    `Tarefa macro do plano de geração #${geracaoId} do projeto "${projetoNome}" (${slug}) — posição ${posicao}/${total} na cadeia topológica.`,
    '',
    '## Objetivo',
    tarefa.objetivo,
    '',
    '## Escopo',
    tarefa.escopo,
    '',
    '## Critérios de aceite',
    ...tarefa.aceite.map((item) => `- ${item}`),
    '',
    '## Requisitos cobertos',
    tarefa.requisitos.join(', '),
    '',
    '## Execução',
    `- Executor: ${tarefa.executor}`,
    `- Risco: ${tarefa.risco}`,
    `- auto_start: ${tarefa.auto_start ? 'sim' : 'não (sequência controlada por dependência)'}`,
    '',
    '## Referências',
    `- Especificação do projeto: projects/${slug}/docs/ESPECIFICACAO.md (seção correspondente aos REQ-* acima)`,
    `- Especificação CRUD (fonte de verdade para config.ts/schema.ts): projects/${slug}/docs/ESPEC-CRUD.md`,
    `- Plano macro aprovado: geracoes_projeto #${geracaoId} (coluna tasks)`,
  ];
  return linhas.join('\n');
}

/**
 * Conteúdo de projects/<slug>/docs/ESPEC-CRUD.md (§4) — artefato declarativo
 * que dirige o config.ts/schema.ts do projeto, gerado a partir da
 * especificacaoCrud do plano aprovado.
 */
export function montarConteudoEspecCrud(contexto: {
  projetoNome: string;
  slug: string;
  geracaoId: number;
  plano: MacroPlanoValidado;
  aprovadoEm: Date;
}): string {
  const { projetoNome, slug, geracaoId, plano, aprovadoEm } = contexto;
  const linhas: string[] = [
    `# ESPEC-CRUD — ${projetoNome} (${slug})`,
    '',
    '> Fonte de verdade para `config.ts`/`schema.ts` do projeto',
    '> (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §4). Gerado a partir do plano',
    `> macro aprovado (geracoes_projeto #${geracaoId}) em ${aprovadoEm.toISOString()}.`,
    '> Edições manuais devem preservar este formato.',
    '',
    '## Classificação do sistema',
    '',
    `- Classificação: ${plano.classificacaoSistema}`,
    `- Requer agente dedicado: ${plano.requerAgenteDedicado ? 'sim' : 'não'}`,
    '',
    '## Entidades',
  ];
  for (const entidade of plano.especificacaoCrud.entidades) {
    linhas.push('', `### ${entidade.nome}`);
    if (entidade.menu) linhas.push(`- Menu: ${entidade.menu}`);
    linhas.push('- Campos:');
    for (const campo of entidade.campos) linhas.push(`  - ${campo}`);
    if (entidade.mascarasValidacoes.length > 0) {
      linhas.push('- Máscaras/validações:');
      for (const mascara of entidade.mascarasValidacoes) linhas.push(`  - ${mascara}`);
    }
  }
  if (plano.especificacaoCrud.observacoes) {
    linhas.push('', '## Observações', '', plano.especificacaoCrud.observacoes);
  }
  linhas.push('');
  return linhas.join('\n');
}
