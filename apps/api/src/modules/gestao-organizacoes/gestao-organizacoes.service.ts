/**
 * GestãoOrganizacoesService — endpoints de administração de organizações e
 * colaboradores do gestao-de-tarefas-global (macro #2, subtarefa 3).
 *
 * Fronteiras de responsabilidade:
 * - MASTER (sessão `biblioteca-global` + perfil admin): cria organização e
 *   designa o primeiro admin — cria colaborador ATIVO vinculado por
 *   `usuarioId` (colaboradores.usuario_id) e garante perfil `admin` no pivot
 *   `projetos_usuarios` do projeto. A partir daí o guard de tenancy
 *   (subtarefa 1) resolve o escopo do admin imediatamente.
 * - ADMIN DA ORGANIZAÇÃO (sessão `gestao-de-tarefas-global` + colaborador
 *   ativo + perfil admin): cadastra/edita colaboradores com `organizacaoId`
 *   FORÇADO pela sessão; payload apontando para outra organização é rejeitado.
 *
 * Invariantes de vínculo colaborador↔usuário (REQ-F-016/017, REQ-D-001):
 * - `usuarioId` precisa existir em core.usuarios e estar ativo;
 * - um colaborador ATIVO por organização por `usuarioId` (duplicidade → 409);
 * - colaborador fora da organização da sessão → 404 (padrão do tenancy:
 *   registro "não existe" para quem não pode vê-lo);
 * - desvincular = `usuarioId: null` (colaborador inativo/desvinculado não
 *   resolve escopo — regra do resolver da subtarefa 1).
 *
 * Sem FK física core↔projeto (banco do projeto é isolado): validações de
 * `usuarioId` cruzam core e projeto em consultas separadas, ordem
 * validar→gravar (sem transação distribuída possível).
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, ne } from "drizzle-orm"
import { projetos, projetosUsuarios, usuarios } from "../../../../../database/schema"
import {
  colaboradores as colaboradoresTabela,
  organizacoes,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import type { ContextoEscopoOrganizacao } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { exigirContextoColaborador } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/resolvers"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../crud/project-db.factory"
import { SLUG_GESTAO_TAREFAS_GLOBAL } from "../crud/escopo/gestao-tarefas-global.escopo"
/**
 * Schemas Zod usados pelo service (import estático: sob ESM/vitest o require
 * relativo não resolve; não há ciclo real — o dto não importa o service).
 */
import {
  criarColaboradorSchema,
  atualizarColaboradorSchema,
  type AtualizarColaboradorInput,
  type CriarColaboradorInput,
  type CriarOrganizacaoInput,
} from "./dto/gestao-organizacoes.schemas"

/** Contexto de colaborador já traduzido (organização da sessão). */
type CtxAdmin = Extract<ContextoEscopoOrganizacao, { tipo: "colaborador" }>

/** Coluna crua de organização aceita em payloads legados do CRUD (snake_case). */
const CHAVES_ORGANIZACAO = ["organizacaoId", "organizacao_id"] as const

function linhaColaborador(linha: {
  id: unknown
  organizacaoId: unknown
  nome: string
  email: string
  telefone: string | null
  cpf: string | null
  ativo: boolean
  usuarioId: unknown
}) {
  return {
    id: Number(linha.id),
    organizacaoId: Number(linha.organizacaoId),
    nome: linha.nome,
    email: linha.email,
    telefone: linha.telefone,
    cpf: linha.cpf,
    ativo: linha.ativo,
    usuarioId: linha.usuarioId == null ? null : Number(linha.usuarioId),
  }
}

@Injectable()
export class GestãoOrganizacoesService {
  private projetoIdCache: number | null = null

  // @Inject explícito: DI funcional sem emitDecoratorMetadata (tsx/esbuild).
  constructor(
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  // ==========================================================================
  // MASTER — criação de organização + primeiro admin
  // ==========================================================================

  /**
   * Cria a organização e designa o primeiro admin (fim a fim):
   * 1. valida o usuário global (core.usuarios, ativo);
   * 2. insere `organizacoes`;
   * 3. insere `colaboradores` ATIVO vinculado por `usuarioId`;
   * 4. garante perfil `admin` em `projetos_usuarios` (insert ou elevação).
   */
  async criarOrganizacaoComAdmin(input: CriarOrganizacaoInput) {
    const projetoId = await this.resolverProjetoId()
    await this.validarUsuarioGlobal(input.admin.usuarioId)

    const db = await this.obterDbProjeto()

    const [orgRow] = await db
      .insert(organizacoes)
      .values({ nome: input.nome, descricao: input.descricao ?? null })
      .$returningId()
    const organizacaoId = Number(orgRow!.id)

    const [colabRow] = await db
      .insert(colaboradoresTabela)
      .values({
        organizacaoId,
        nome: input.admin.nome,
        email: input.admin.email,
        telefone: input.admin.telefone ?? null,
        cpf: input.admin.cpf ?? null,
        ativo: true,
        usuarioId: input.admin.usuarioId,
      })
      .$returningId()

    // Garante o vínculo do usuário com o projeto em perfil admin (cria ou
    // eleva). Sem isso o admin designado não passa em ProjectScopeGuard.
    await this.garantirPerfilAdminNoProjeto(projetoId, input.admin.usuarioId)

    const colaborador = await this.buscarColaborador(db, Number(colabRow!.id))
    return { organizacaoId, colaborador }
  }

  // ==========================================================================
  // ADMIN DA ORGANIZAÇÃO — colaboradores com organizacaoId forçado
  // ==========================================================================

  /** Cadastra colaborador na organização da sessão (body nunca escolhe organização). */
  async criarColaborador(
    contexto: ContextoEscopoOrganizacao,
    corpo: Record<string, unknown>,
  ) {
    const ctx = this.exigirAdmin(contexto, corpo)
    const input = this.parseCriar(corpo)
    const db = await this.obterDbProjeto()

    if (input.usuarioId !== undefined) {
      await this.validarVinculoUsuario(db, ctx.organizacaoId, input.usuarioId, null)
    }

    const [row] = await db
      .insert(colaboradoresTabela)
      .values({
        organizacaoId: ctx.organizacaoId, // SEMPRE a organização da sessão.
        nome: input.nome,
        email: input.email,
        telefone: input.telefone ?? null,
        cpf: input.cpf ?? null,
        ativo: input.ativo,
        usuarioId: input.usuarioId ?? null,
      })
      .$returningId()
    return this.buscarColaborador(db, Number(row!.id))
  }

  /** Edição parcial de colaborador da própria organização (fora do escopo → 404). */
  async atualizarColaborador(
    contexto: ContextoEscopoOrganizacao,
    id: number,
    corpo: Record<string, unknown>,
  ) {
    const ctx = this.exigirAdmin(contexto, corpo)
    const input = this.parseAtualizar(corpo as never)
    const db = await this.obterDbProjeto()
    await this.buscarColaboradorNaOrganizacao(db, ctx.organizacaoId, id)

    if (input.usuarioId !== undefined) {
      await this.validarVinculoUsuario(db, ctx.organizacaoId, input.usuarioId, id)
    }

    const set: Record<string, unknown> = {}
    for (const campo of ["nome", "email", "telefone", "cpf", "ativo", "usuarioId"] as const) {
      if (input[campo] !== undefined) {
        set[campo === "usuarioId" ? "usuarioId" : campo] =
          input[campo] === null ? null : (input[campo] as never)
      }
    }
    await db
      .update(colaboradoresTabela)
      .set(set)
      .where(eq(colaboradoresTabela.id, id))
    return this.buscarColaborador(db, id)
  }

  /** Vínculo/desvínculo colaborador↔usuário (PUT .../usuario). */
  async vincularUsuario(
    contexto: ContextoEscopoOrganizacao,
    id: number,
    usuarioId: number | null,
  ) {
    const ctx = this.exigirAdmin(contexto)
    const db = await this.obterDbProjeto()
    await this.buscarColaboradorNaOrganizacao(db, ctx.organizacaoId, id)

    if (usuarioId !== null) {
      await this.validarVinculoUsuario(db, ctx.organizacaoId, usuarioId, id)
    }
    await db
      .update(colaboradoresTabela)
      .set({ usuarioId })
      .where(eq(colaboradoresTabela.id, id))
    return this.buscarColaborador(db, id)
  }

  // ==========================================================================
  // Internos
  // ==========================================================================

  /**
   * Traduz o contexto do guard para colaborador (master → 403 claro) e
   * rejeita payload que tente escolher/gravar outra organização
   * (critério: "payload com outra organizacaoId é rejeitado").
   */
  private exigirAdmin(
    contexto: ContextoEscopoOrganizacao | undefined,
    corpo?: Record<string, unknown>,
  ): CtxAdmin {
    if (!contexto) {
      throw new BadRequestException(
        "Contexto de organização não resolvido — sessão inválida para gestão de colaboradores.",
      )
    }
    const ctx = exigirContextoColaborador(contexto)
    if (ctx.perfil !== "admin") {
      throw new ConflictException(
        "Gestão de colaboradores é exclusiva do perfil admin da organização.",
      )
    }
    if (corpo) {
      for (const chave of CHAVES_ORGANIZACAO) {
        if (!(chave in corpo)) continue
        const valor = Number(corpo[chave])
        if (valor !== ctx.organizacaoId) {
          throw new BadRequestException(
            `"${chave}": a organização é sempre a da sessão — não é possível gravar colaboradores em outra organização.`,
          )
        }
      }
    }
    return ctx
  }

  /** Zod com mensagem clara em `details` (padrão ocorrencias.controller). */
  private parseCriar(corpo: unknown): CriarColaboradorInput {
    return parseOu400(criarColaboradorSchema, corpo) as CriarColaboradorInput
  }

  private parseAtualizar(corpo: unknown): AtualizarColaboradorInput {
    return parseOu400(atualizarColaboradorSchema, corpo) as AtualizarColaboradorInput
  }

  private async obterDbProjeto(): Promise<ProjetoDb> {
    const projetoId = await this.resolverProjetoId()
    return this.factory.obter({ id: projetoId })
  }

  /** Resolve (e cacheia) o id do projeto gestao-de-tarefas-global no core. */
  private async resolverProjetoId(): Promise<number> {
    if (this.projetoIdCache !== null) return this.projetoIdCache
    const linha = (
      await this.coreDb
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, SLUG_GESTAO_TAREFAS_GLOBAL))
        .limit(1)
    ).at(0)
    if (!linha) {
      throw new NotFoundException(
        `Projeto "${SLUG_GESTAO_TAREFAS_GLOBAL}" não provisionado no core — gestão de organizações indisponível.`,
      )
    }
    this.projetoIdCache = Number(linha.id)
    return this.projetoIdCache
  }

  /** core.usuarios precisa existir e estar ativo (vínculo de login). */
  private async validarUsuarioGlobal(usuarioId: number): Promise<void> {
    const linha = (
      await this.coreDb
        .select({ id: usuarios.id, ativo: usuarios.ativo })
        .from(usuarios)
        .where(eq(usuarios.id, usuarioId))
        .limit(1)
    ).at(0)
    if (!linha) {
      throw new NotFoundException(
        `Usuário global ${usuarioId} não existe — cadastre-o na tela de Usuários da plataforma antes de vincular.`,
      )
    }
    if (!linha.ativo) {
      throw new BadRequestException(
        `Usuário global ${usuarioId} está inativo — reative-o na plataforma antes de vincular.`,
      )
    }
  }

  /** Insert ou elevação do perfil para `admin` em projetos_usuarios. */
  private async garantirPerfilAdminNoProjeto(
    projetoId: number,
    usuarioId: number,
  ): Promise<void> {
    const existente = (
      await this.coreDb
        .select({ perfil: projetosUsuarios.perfil })
        .from(projetosUsuarios)
        .where(
          and(
            eq(projetosUsuarios.projetoId, projetoId),
            eq(projetosUsuarios.usuarioId, usuarioId),
          ),
        )
        .limit(1)
    ).at(0)
    if (!existente) {
      await this.coreDb.insert(projetosUsuarios).values({
        projetoId,
        usuarioId,
        perfil: "admin",
      })
    } else if (existente.perfil !== "admin") {
      await this.coreDb
        .update(projetosUsuarios)
        .set({ perfil: "admin" })
        .where(
          and(
            eq(projetosUsuarios.projetoId, projetoId),
            eq(projetosUsuarios.usuarioId, usuarioId),
          ),
        )
    }
  }

  /**
   * Invariantes do vínculo: usuário global válido + nenhum OUTRO colaborador
   * ATIVO da mesma organização já vinculado a esse usuarioId (409).
   */
  private async validarVinculoUsuario(
    db: ProjetoDb,
    organizacaoId: number,
    usuarioId: number,
    excetoColaboradorId: number | null,
  ): Promise<void> {
    await this.validarUsuarioGlobal(usuarioId)
    const condicoes = [
      eq(colaboradoresTabela.organizacaoId, organizacaoId),
      eq(colaboradoresTabela.usuarioId, usuarioId),
      eq(colaboradoresTabela.ativo, true),
    ]
    if (excetoColaboradorId !== null) {
      condicoes.push(ne(colaboradoresTabela.id, excetoColaboradorId))
    }
    const conflito = (
      await db
        .select({ id: colaboradoresTabela.id })
        .from(colaboradoresTabela)
        .where(and(...condicoes))
        .limit(1)
    ).at(0)
    if (conflito) {
      throw new ConflictException(
        `O usuário global ${usuarioId} já está vinculado a outro colaborador ativo desta organização (colaborador ${Number(conflito.id)}).`,
      )
    }
  }

  /** Leitura fora da organização da sessão → 404 (padrão do tenancy). */
  private async buscarColaboradorNaOrganizacao(
    db: ProjetoDb,
    organizacaoId: number,
    id: number,
  ) {
    const linhas = await db
      .select({
        id: colaboradoresTabela.id,
        organizacaoId: colaboradoresTabela.organizacaoId,
        nome: colaboradoresTabela.nome,
        email: colaboradoresTabela.email,
        telefone: colaboradoresTabela.telefone,
        cpf: colaboradoresTabela.cpf,
        ativo: colaboradoresTabela.ativo,
        usuarioId: colaboradoresTabela.usuarioId,
      })
      .from(colaboradoresTabela)
      .where(
        and(
          eq(colaboradoresTabela.id, id),
          eq(colaboradoresTabela.organizacaoId, organizacaoId),
        ),
      )
      .limit(1)
    const linha = linhas[0]
    if (!linha) {
      throw new NotFoundException(
        "Colaborador não encontrado nesta organização.",
      )
    }
    return linhaColaborador(linha)
  }

  private async buscarColaborador(db: ProjetoDb, id: number) {
    const linhas = await db
      .select({
        id: colaboradoresTabela.id,
        organizacaoId: colaboradoresTabela.organizacaoId,
        nome: colaboradoresTabela.nome,
        email: colaboradoresTabela.email,
        telefone: colaboradoresTabela.telefone,
        cpf: colaboradoresTabela.cpf,
        ativo: colaboradoresTabela.ativo,
        usuarioId: colaboradoresTabela.usuarioId,
      })
      .from(colaboradoresTabela)
      .where(eq(colaboradoresTabela.id, id))
      .limit(1)
    const linha = linhas[0]
    if (!linha) {
      throw new NotFoundException("Colaborador não encontrado após a gravação.")
    }
    return linhaColaborador(linha)
  }
}

/** Zod 4 (`$ZodIssue.path` é `PropertyKey[]`) → mensagem clara em `details`. */
function parseOu400(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean
      data?: unknown
      error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }
    }
  },
  corpo: unknown,
) {
  const parsed = schema.safeParse(corpo)
  if (!parsed.success) {
    throw new BadRequestException({
      message: "Dados de colaborador inválidos",
      details: (parsed.error?.issues ?? []).map((issue) => ({
        caminho: issue.path.map((parte) => String(parte)).join("."),
        problema: issue.message,
      })),
    })
  }
  return parsed.data
}
