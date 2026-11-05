/**
 * Config BASE versionada do projeto `gestao-de-tarefas-global` (PoC §7,
 * MANUAL_CONFIG_PROJETOS §1) — mesma fonte da config corrente no core
 * (projetos.config, id 8496). Fonte de verdade do modelo: ./schema.ts;
 * fields materializados da derivação schema-tools (gerarFields + annotations
 * + inferirFk) com nomes de PROPRIEDADE TS (camelCase), que é o contrato das
 * linhas retornadas pelo CRUD genérico (drizzle) e aceito no body via
 * normalizarChaves.
 *
 * Decisões (docs/ESPEC-CRUD.md, plano macro geracoes_projeto #1):
 * - Grupos: Cadastros (Áreas, Tags) · Tarefas (Todas as tarefas, Recorrências)
 *   · Administração (Organizações admin, Colaboradores admin|gerente).
 * - roleFilter é o mecanismo de visibilidade: Organizações só admin;
 *   Colaboradores só admin|gerente (perfis autorizados a ver dados sensíveis
 *   — clarificação 8; por isso cpf NÃO entra em hiddenColumns: quem acessa a
 *   tela pode vê-lo). Operador/visualizador não vê o grupo Administração.
 *   O bloqueio backend de campos sensíveis para outros perfis é da macro 2
 *   (tenancy/permissões).
 * - Máscaras/validadores cpf, telefone e nomeCompleto vêm das annotations do
 *   schema (front: DynamicForm/formValidation; email validado por type).
 * - tarefa_tags é pivot SEM tela: tags são editadas na própria tarefa via
 *   campo virtual "tags" (multipleChoice multiple → o CRUD genérico sincroniza
 *   o pivot; ver CrudService.camposPivotDoResource).
 * - mensagens_tarefa (Chat), historico_tarefas (Histórico) e anexos (Anexos)
 *   não têm tela de cadastro própria: são childScreens (master-detail) de
 *   tarefas — a grid de filhos do Cadastro é somente leitura (histórico é
 *   append-only por decisão). Telas custom chegam nas macros 3–6.
 * - notificacoes não tem tela (consumida pelo sino custom — macro 5).
 * - status de tarefa NÃO é editável na tela de cadastro (insertable/editable
 *   false): transitions só via fluxo custom (macro 3). O default "aberta" vem
 *   do schema na criação.
 * - defaultOrderBy de tarefas: prazo asc (vencidas primeiro — lacuna do plano:
 *   "prazo asc + prioridade desc assumido como padrão sensato") + prioridade
 *   desc. O valuesLast do motor de orderBy exige valores concretos da coluna
 *   (CASE WHEN ... IN); prazo é datetime nullable (NULL = sem prazo) e não tem
 *   valores enumeráveis — por isso não se declara valuesLast aqui.
 * - lembreteAntecedenciaMinutos: NULL = sem aviso; proibido não-nulo com prazo
 *   NULL (regra de domínio validada no backend — macro 5). Aqui, helperText.
 * - Regras de recorrência: dataFim com minDate dinâmico >= dataInicio
 *   (minDateField — validação de form); proximaGeracao é calculada pelo motor
 *   de recorrência (macro 4) — não editável.
 * - Responsável de área e de tarefa referencia colaboradores SEM filtro de
 *   papel: líder é cadastrável como responsável (REQ-F-018).
 * - Telas derivadas do GeradorSistema já são responsivas (REQ-F-020).
 */
import {
  geradorSistemaConfigSchema,
  type GeradorSistemaConfig,
} from "@biblioteca-global/shared"

const configBase: GeradorSistemaConfig = {
  app: { name: "Gestão de Tarefas Global", logo: "viewlist" },
  groups: [
    // ========================================================================
    // CADASTROS
    // ========================================================================
    {
      id: "cadastros",
      label: "Cadastros",
      items: [
        {
          id: "areas",
          label: "Áreas",
          path: "areas",
          icon: "groups",
          screen: {
            kind: "cadastro",
            resource: "areas",
            title: "Áreas",
            description: "Áreas da organização; o líder é um colaborador cadastrável como responsável",
            fields: [
              {
                name: "organizacaoId",
                label: "Organização",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "organizacoes", idField: "id", displayField: "nome" },
              },
              { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", required: false, fullWidth: true },
              {
                // Sem filtro de papel: líder cadastrável como responsável (REQ-F-018).
                name: "responsavelId",
                label: "Responsável (líder)",
                type: "multipleChoice",
                required: false,
                multipleChoice: { resource: "colaboradores", idField: "id", displayField: "nome" },
              },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID", organizacaoId: "Organização", responsavelId: "Responsável" },
              newLabel: "Nova área",
            },
          },
        },
        {
          id: "tags",
          label: "Tags",
          path: "tags",
          icon: "grid",
          screen: {
            kind: "cadastro",
            resource: "tags",
            title: "Tags",
            description: "Categorias das tarefas (vínculo editado na própria tarefa)",
            fields: [
              {
                name: "organizacaoId",
                label: "Organização",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "organizacoes", idField: "id", displayField: "nome" },
              },
              { name: "nome", label: "Nome", type: "text", required: true },
            ],
            overrides: {
              columnLabels: { id: "ID", organizacaoId: "Organização" },
              newLabel: "Nova tag",
            },
          },
        },
      ],
    },

    // ========================================================================
    // TAREFAS
    // ========================================================================
    {
      id: "tarefas",
      label: "Tarefas",
      items: [
        {
          id: "tarefas",
          label: "Todas as tarefas",
          path: "tarefas",
          icon: "viewlist",
          screen: {
            kind: "cadastro",
            resource: "tarefas",
            title: "Todas as tarefas",
            description: "Vencidas primeiro (prazo asc), mais urgentes no topo (prioridade desc)",
            fields: [
              {
                name: "organizacaoId",
                label: "Organização",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "organizacoes", idField: "id", displayField: "nome" },
              },
              { name: "titulo", label: "Título", type: "text", required: true, minLength: 3, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", required: false, fullWidth: true },
              {
                name: "areaId",
                label: "Área",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "areas", idField: "id", displayField: "nome" },
              },
              {
                // Sem filtro de papel: líder cadastrável como responsável (REQ-F-018).
                name: "responsavelId",
                label: "Responsável",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "colaboradores", idField: "id", displayField: "nome" },
              },
              {
                name: "criadoPorId",
                label: "Criado por",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "colaboradores", idField: "id", displayField: "nome" },
              },
              {
                name: "prioridade",
                label: "Prioridade",
                type: "select",
                required: false,
                defaultValue: "media",
                options: [
                  { label: "Baixa", value: "baixa" },
                  { label: "Média", value: "media" },
                  { label: "Alta", value: "alta" },
                  { label: "Urgente", value: "urgente" },
                ],
              },
              {
                name: "prazo",
                label: "Prazo",
                type: "date",
                required: false,
                helperText: "Vazio = sem prazo (sem aviso de lembrete)",
              },
              {
                // Editável apenas via endpoints do fluxo custom (macro 3) —
                // a máquina de estados não pertence à tela de cadastro.
                name: "status",
                label: "Status",
                type: "select",
                required: false,
                insertable: false,
                editable: false,
                options: [
                  { label: "Aberta", value: "aberta" },
                  { label: "Delegada", value: "delegada" },
                  { label: "Concluída", value: "concluida" },
                  { label: "Precisa de informações", value: "precisa_informacoes" },
                  { label: "Aguardando terceiro", value: "aguardando_terceiro" },
                  { label: "Cancelada", value: "cancelada" },
                ],
              },
              {
                name: "lembreteAntecedenciaMinutos",
                label: "Lembrete (minutos antes do prazo)",
                type: "number",
                required: false,
                min: 1,
                helperText: "Vazio = sem aviso. Só é permitido quando há prazo (prazo vazio proíbe lembrete).",
              },
              {
                name: "regraRecorrenciaId",
                label: "Regra de recorrência",
                type: "multipleChoice",
                required: false,
                multipleChoice: { resource: "regras_recorrencia", idField: "id", displayField: "titulo" },
              },
              {
                // Preenchido pelo fluxo custom de conclusão (macro 3).
                name: "concluidaEm",
                label: "Concluída em",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
              },
              {
                // Campo VIRTUAL do pivot tarefa_tags (sem tela própria): o CRUD
                // genérico sincroniza os vínculos ao criar/editar a tarefa.
                name: "tags",
                label: "Tags",
                type: "multipleChoice",
                required: false,
                gridVisible: false,
                multipleChoice: { resource: "tags", idField: "id", displayField: "nome", multiple: true },
              },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                organizacaoId: "Organização",
                areaId: "Área",
                responsavelId: "Responsável",
                criadoPorId: "Criado por",
                regraRecorrenciaId: "Recorrência",
                lembreteAntecedenciaMinutos: "Lembrete (min)",
              },
              newLabel: "Nova tarefa",
            },
            // Master-detail: estruturas de chat/histórico/anexos (somente
            // leitura na grid de filhos; telas custom virão nas macros 3–6).
            children: [
              { childResource: "mensagens_tarefa", fkField: "tarefaId", label: "Chat" },
              { childResource: "historico_tarefas", fkField: "tarefaId", label: "Histórico" },
              { childResource: "anexos", fkField: "tarefaId", label: "Anexos" },
            ],
            defaultOrderBy: [
              { campo: "prazo", direction: "asc" },
              { campo: "prioridade", direction: "desc" },
            ],
          },
        },
        {
          id: "regras_recorrencia",
          label: "Recorrências",
          path: "regras_recorrencia",
          icon: "dashboard",
          screen: {
            kind: "cadastro",
            resource: "regras_recorrencia",
            title: "Recorrências",
            description: "Regras de geração automática de tarefas (motor de recorrência — macro 4)",
            fields: [
              {
                name: "organizacaoId",
                label: "Organização",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "organizacoes", idField: "id", displayField: "nome" },
              },
              { name: "titulo", label: "Título", type: "text", required: true, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", required: false, fullWidth: true },
              {
                name: "areaId",
                label: "Área",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "areas", idField: "id", displayField: "nome" },
              },
              {
                name: "responsavelId",
                label: "Responsável",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "colaboradores", idField: "id", displayField: "nome" },
              },
              {
                name: "frequencia",
                label: "Frequência",
                type: "select",
                required: true,
                options: [
                  { label: "Diária", value: "diaria" },
                  { label: "Semanal", value: "semanal" },
                  { label: "Mensal", value: "mensal" },
                ],
              },
              {
                name: "diasSemana",
                label: "Dias da semana",
                type: "json",
                required: false,
                helperText: "Obrigatório para frequência semanal. Ex.: [1, 3, 5] (1 = segunda).",
              },
              {
                name: "horaDoDia",
                label: "Hora do dia",
                type: "text",
                required: false,
                placeholder: "09:00:00",
              },
              { name: "dataInicio", label: "Data de início", type: "date", required: true },
              {
                name: "dataFim",
                label: "Data de fim",
                type: "date",
                required: false,
                // minDate dinâmico: não pode ser anterior à data de início
                // (NULL = sem fim).
                minDateField: "dataInicio",
                helperText: "Vazio = sem fim. Deve ser maior ou igual à data de início.",
              },
              { name: "ativa", label: "Ativa", type: "switch", required: false, defaultValue: true },
              {
                // Calculada pelo motor de recorrência (macro 4) — não editável.
                name: "proximaGeracao",
                label: "Próxima geração",
                type: "text",
                required: false,
                insertable: false,
                editable: false,
              },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: {
                id: "ID",
                organizacaoId: "Organização",
                areaId: "Área",
                responsavelId: "Responsável",
                dataInicio: "Início",
                dataFim: "Fim",
              },
              newLabel: "Nova recorrência",
            },
          },
        },
      ],
    },

    // ========================================================================
    // ADMINISTRAÇÃO
    // ========================================================================
    {
      id: "administracao",
      label: "Administração",
      items: [
        {
          id: "organizacoes",
          label: "Organizações",
          path: "organizacoes",
          icon: "folder",
          roleFilter: ["admin"],
          screen: {
            kind: "cadastro",
            resource: "organizacoes",
            title: "Organizações",
            description: "Organizações do sistema (projeto único com isolamento row-level — macro 2)",
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, minLength: 2, fullWidth: true },
              { name: "descricao", label: "Descrição", type: "textarea", required: false, fullWidth: true },
              { name: "ativa", label: "Ativa", type: "switch", required: false, defaultValue: true },
            ],
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columnLabels: { id: "ID" },
              newLabel: "Nova organização",
            },
          },
        },
        {
          id: "colaboradores",
          label: "Colaboradores",
          path: "colaboradores",
          icon: "people",
          // Dados sensíveis (cpf): visíveis apenas para admin/gerente
          // (clarificação 8) — o roleFilter é a barreira de visibilidade;
          // o bloqueio backend por perfil é da macro 2.
          roleFilter: ["admin", "gerente"],
          screen: {
            kind: "cadastro",
            resource: "colaboradores",
            title: "Colaboradores",
            description: "Pessoas que executam e lideram tarefas",
            fields: [
              {
                name: "organizacaoId",
                label: "Organização",
                type: "multipleChoice",
                required: true,
                multipleChoice: { resource: "organizacoes", idField: "id", displayField: "nome" },
              },
              {
                name: "nome",
                label: "Nome completo",
                type: "text",
                required: true,
                fullWidth: true,
                validator: "nomeCompleto",
              },
              { name: "email", label: "E-mail", type: "email", required: true, fullWidth: true },
              {
                name: "telefone",
                label: "Telefone",
                type: "text",
                required: false,
                mask: "telefone",
                validator: "telefone",
              },
              {
                name: "cpf",
                label: "CPF",
                type: "text",
                required: false,
                mask: "cpf",
                validator: "cpf",
              },
              { name: "ativo", label: "Ativo", type: "switch", required: false, defaultValue: true },
              {
                name: "usuarioId",
                label: "Usuário da plataforma",
                type: "number",
                required: false,
                helperText: "ID do usuário global (core) vinculado — sem FK física (bancos isolados).",
              },
            ],
            overrides: {
              columnLabels: { id: "ID", organizacaoId: "Organização", usuarioId: "Usuário" },
              newLabel: "Novo colaborador",
            },
          },
        },
      ],
    },
  ],
}

/**
 * Validação em runtime da mesma fonte que o registry da web consome.
 * A tela sistêmica de Usuários é injetada pela plataforma e, por isso, não
 * pertence aos grupos de negócio deste projeto.
 */
export const config = geradorSistemaConfigSchema.parse(configBase)
