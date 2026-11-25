/**
 * GestaoTarefasGlobalAnexosService — anexos de tarefa (gestao-de-tarefas-global
 * — macro #6, subtarefa 1): upload multipart, armazenamento em disco e
 * download/preview (REQ-F-013, REQ-D-008).
 *
 * Regras:
 * - Armazenamento em disco sob `ANEXOS_DIR` com CHAVE LÓGICA
 *   `org/{organizacaoId}/tarefa/{tarefaId}/{uuid}.{ext}` — o caminho físico
 *   nunca aparece em resposta, em coluna do banco nem em log (a tabela
 *   `anexos.chave_armazenamento` guarda somente a chave lógica);
 * - Saneamento: `basename` (sem path traversal) + sanitização de caracteres +
 *   whitelist de extensão/MIME (pdf, png, jpg/jpeg e textos: txt, js, md,
 *   csv, json, log + qualquer MIME `text/*`);
 * - Limite de tamanho (~10MB, `ANEXOS_MAX_BYTES`): rejeição 400 com
 *   mensagem indicando o máximo;
 * - Escopo row-level idêntico ao CRUD/fluxo: tarefa OU anexo de outra
 *   organização → 404 (o filtro `organizacao_id` entra no WHERE — o id
 *   nunca vaza existência de registro de outra organização);
 * - Upload: linha em `anexos` + evento `historico_tarefas`
 *   (tipoEvento 'anexo', com o nome do arquivo) na MESMA transação
 *   (padrão do fluxo — atômico; histórico append-only, sem rotas
 *   PUT/PATCH/DELETE neste módulo);
 * - Preview/download: Content-Disposition inline SOMENTE para image/png,
 *   image/jpeg e application/pdf; demais tipos vão attachment.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, extname, resolve, sep } from "node:path"
import { and, asc, eq, inArray } from "drizzle-orm"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import {
  anexos,
  colaboradores,
  historicoTarefas,
  tarefas,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import {
  exigirContextoColaborador,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/resolvers"
import {
  SemColaboradorAtivoError,
  type RequisicaoComEscopoOrganizacao,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { EnvService } from "../../config/env.service"
import { ehErroDatabaseAusente } from "../../common/erros"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../crud/project-db.factory"

/**
 * Arquivo multipart do @nestjs/platform-express (multer memoryStorage).
 * Tipagem local proposital: sem `@types/multer` (sem dependência nova —
 * multer é transitivo da plataforma express do Nest).
 */
export interface ArquivoAnexoMultipart {
  originalname?: string
  filename?: string
  mimetype?: string
  size?: number
  buffer?: Buffer
  stream?: unknown
  encoding?: string
}

/** Contexto de colaborador da sessão (guard de escopo já validou). */
export interface ContextoSessaoAnexos {
  organizacaoId: number
  colaboradorId: number
  perfil: Perfil
}

/** Item de anexo exposto pelas rotas (sem caminho físico, nunca). */
export interface ItemAnexo {
  id: number
  nomeArquivo: string
  mimeType: string | null
  tamanhoBytes: number | null
  enviadoPorId: number
  enviadoPorNome: string
  criadoEm: string
  /** Chave LÓGICA de armazenamento (org/{org}/tarefa/{tarefa}/{uuid}.{ext}). */
  chaveArmazenamento: string
}

interface AnexoLinha {
  id: number
  tarefaId: number
  organizacaoId: number
  nomeArquivo: string
  mimeType: string | null
  tamanhoBytes: number | null
  chaveArmazenamento: string
  enviadoPorId: number
  criadoEm: Date
}

/** MIMES binários permitidos, por extensão (exatas). */
const MIMES_BINARIOS_POR_EXTENSAO: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
}

/** Extensões de texto aceitas mesmo sem MIME declarado. */
const EXTENSOES_TEXTO = new Set<string>([
  "txt",
  "js",
  "mjs",
  "cjs",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "ini",
  "cfg",
  "conf",
  "sh",
  "sql",
  "toml",
  "properties",
])

/** MIMES renderizáveis inline no navegador (preview). */
const MIMES_INLINE = new Set<string>([
  "image/png",
  "image/jpeg",
  "application/pdf",
])

const MENSAGEM_TIPO_NAO_PERMITIDO =
  "Tipo de arquivo não permitido. Aceitos: PDF (application/pdf), PNG (image/png), " +
  "JPEG (image/jpeg) e textos (TXT, JS, MD, CSV, JSON, LOG e demais MIME text/*)."

/**
 * Sanitiza o nome enviado: `basename` elimina path traversal
 * (`../../etc/x` → `x`) e caracteres fora do conjunto seguro viram `_`.
 */
function nomeArquivoSeguro(nomeOriginal: string): string {
  const semCaminho = basename((nomeOriginal ?? "").replace(/\\/g, "/"))
  const sanitizado = semCaminho.replace(/[^a-zA-Z0-9._-]/g, "_")
  return (sanitizado.length > 0 ? sanitizado : "arquivo").slice(0, 255)
}

/**
 * Whitelist de tipo: extensão (do nome sanitizado) + MIME declarado.
 * Binários exigem o MIME exato; texto exige extensão conhecida ou MIME
 * `text/*`. Devolve a extensão (minúscula, sem ponto) e o MIME canônico.
 */
function validarTipoArquivo(
  nomeArquivo: string,
  mimeDeclarado: string | null | undefined,
): { extensao: string; mimeType: string } {
  const extensao = extname(nomeArquivo).replace(/^\./, "").toLowerCase()
  const mime = (mimeDeclarado ?? "").trim().toLowerCase()

  const mimeBinario = MIMES_BINARIOS_POR_EXTENSAO[extensao]
  if (mimeBinario) {
    if (mime !== "" && mime !== mimeBinario) {
      throw new BadRequestException(MENSAGEM_TIPO_NAO_PERMITIDO)
    }
    return { extensao, mimeType: mimeBinario }
  }

  const ehTexto = EXTENSOES_TEXTO.has(extensao) || mime.startsWith("text/")
  if (!ehTexto || (mime !== "" && !mime.startsWith("text/"))) {
    throw new BadRequestException(MENSAGEM_TIPO_NAO_PERMITIDO)
  }
  return { extensao, mimeType: mime !== "" ? mime : "text/plain" }
}

@Injectable()
export class GestaoTarefasGlobalAnexosService {
  private readonly logger = new Logger(GestaoTarefasGlobalAnexosService.name)

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    private readonly env: EnvService,
  ) {}

  // ==========================================================================
  // Contexto / escopo
  // ==========================================================================

  /**
   * Contexto de colaborador da request (guard de escopo executado):
   * master da plataforma e usuário sem colaborador ativo → 403.
   */
  contextoDaRequest(
    req: RequisicaoComEscopoOrganizacao,
  ): ContextoSessaoAnexos {
    if (!req.escopoOrganizacao) {
      throw new ForbiddenException(
        "Contexto de organização não resolvido — EscopoOrganizacaoGuard não executou.",
      )
    }
    try {
      const contexto = exigirContextoColaborador(req.escopoOrganizacao)
      return {
        organizacaoId: contexto.organizacaoId,
        colaboradorId: contexto.colaboradorId,
        perfil: contexto.perfil,
      }
    } catch (erro) {
      if (erro instanceof SemColaboradorAtivoError) {
        throw new ForbiddenException(erro.message)
      }
      throw erro
    }
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    try {
      return await this.factory.obter({ id: projeto.id })
    } catch (erro: unknown) {
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  /**
   * Tarefa pelo id DENTRO da organização da sessão — fora do escopo → 404
   * (mesma semântica do CRUD/fluxo row-level).
   */
  private async carregarTarefaNoEscopo(
    db: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    tarefaId: number,
    organizacaoId: number,
  ): Promise<{ id: number; organizacaoId: number; titulo: string }> {
    const [linha] = await db
      .select({
        id: tarefas.id,
        organizacaoId: tarefas.organizacaoId,
        titulo: tarefas.titulo,
      })
      .from(tarefas)
      .where(
        and(
          eq(tarefas.id, tarefaId),
          eq(tarefas.organizacaoId, organizacaoId),
        ),
      )
      .limit(1)
    if (!linha) {
      throw new NotFoundException("Tarefa não encontrada nesta organização.")
    }
    return {
      id: Number(linha.id),
      organizacaoId: Number(linha.organizacaoId),
      titulo: linha.titulo,
    }
  }

  /**
   * Anexo pelo id DENTRO da organização da sessão — outro org → 404 (o
   * filtro `organizacao_id` entra no WHERE; nunca vazar existência de
   * anexo de outra organização).
   */
  private async carregarAnexoNoEscopo(
    db: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    anexoId: number,
    organizacaoId: number,
  ): Promise<AnexoLinha> {
    const [linha] = await db
      .select({
        id: anexos.id,
        tarefaId: anexos.tarefaId,
        organizacaoId: anexos.organizacaoId,
        nomeArquivo: anexos.nomeArquivo,
        mimeType: anexos.mimeType,
        tamanhoBytes: anexos.tamanhoBytes,
        chaveArmazenamento: anexos.chaveArmazenamento,
        enviadoPorId: anexos.enviadoPorId,
        criadoEm: anexos.criadoEm,
      })
      .from(anexos)
      .where(
        and(
          eq(anexos.id, anexoId),
          eq(anexos.organizacaoId, organizacaoId),
        ),
      )
      .limit(1)
    if (!linha) {
      throw new NotFoundException("Anexo não encontrado nesta organização.")
    }
    return {
      id: Number(linha.id),
      tarefaId: Number(linha.tarefaId),
      organizacaoId: Number(linha.organizacaoId),
      nomeArquivo: linha.nomeArquivo,
      mimeType: linha.mimeType ?? null,
      tamanhoBytes: linha.tamanhoBytes == null ? null : Number(linha.tamanhoBytes),
      chaveArmazenamento: linha.chaveArmazenamento,
      enviadoPorId: Number(linha.enviadoPorId),
      criadoEm: linha.criadoEm as Date,
    }
  }

  // ==========================================================================
  // Armazenamento em disco (chave lógica — o caminho físico nunca sai daqui)
  // ==========================================================================

  /**
   * Resolve o caminho físico da chave lógica DENTRO do ANEXOS_DIR (com
   * guarda contra escape). O resultado é usado apenas no service — nunca
   * é serializado para resposta.
   */
  private caminhoFisicoDaChave(chaveArmazenamento: string): string {
    const diretorio = resolve(this.env.anexosDir)
    const caminho = resolve(diretorio, ...chaveArmazenamento.split("/"))
    if (caminho !== diretorio && !caminho.startsWith(diretorio + sep)) {
      // Chave corrompida/inautêntica — tratar como ausente (404), não 500.
      throw new NotFoundException("Anexo não encontrado nesta organização.")
    }
    return caminho
  }

  // ==========================================================================
  // Upload
  // ==========================================================================

  /**
   * POST .../anexos — grava o arquivo em ANEXOS_DIR + linha em `anexos` +
   * evento 'anexo' em `historico_tarefas`, tudo atômico (transação única).
   * Em falha de persistência, remove o arquivo órfão.
   */
  async anexar(
    projeto: ProjetoResumo,
    ctx: ContextoSessaoAnexos,
    tarefaId: number,
    arquivo: ArquivoAnexoMultipart | null | undefined,
  ): Promise<ItemAnexo> {
    if (!arquivo || !arquivo.buffer) {
      throw new BadRequestException(
        "Nenhum arquivo recebido — envie o campo 'arquivo' em multipart/form-data.",
      )
    }
    const conteudo = arquivo.buffer
    const maxBytes = this.env.anexosMaxBytes
    if (conteudo.length > maxBytes) {
      throw new BadRequestException(
        `Arquivo excede o limite de ${maxBytes} bytes (máximo permitido por anexo).`,
      )
    }

    const db = await this.dbDoProjeto(projeto)
    // Escopo row-level ANTES de qualquer efeito em disco (404 fora do escopo).
    const tarefa = await this.carregarTarefaNoEscopo(
      db,
      tarefaId,
      ctx.organizacaoId,
    )

    const nomeArquivo = nomeArquivoSeguro(
      arquivo.originalname ?? arquivo.filename ?? "",
    )
    const { extensao, mimeType } = validarTipoArquivo(
      nomeArquivo,
      arquivo.mimetype,
    )

    const chaveArmazenamento =
      `org/${tarefa.organizacaoId}/tarefa/${tarefa.id}/` +
      `${randomUUID()}.${extensao}`
    const caminhoFisico = this.caminhoFisicoDaChave(chaveArmazenamento)

    await mkdir(dirname(caminhoFisico), { recursive: true })
    try {
      // "wx": nunca sobrescreve — a chave tem uuid, colisão é indesejada.
      await writeFile(caminhoFisico, conteudo, { flag: "wx" })
    } catch (erro) {
      this.logger.error(`Falha ao gravar anexo em disco: ${String(erro)}`)
      throw new BadRequestException(
        "Falha ao armazenar o arquivo no servidor. Tente novamente.",
      )
    }

    const agora = new Date()
    let anexoId: number
    try {
      // Anexo + histórico na MESMA transação (padrão do fluxo — atômico).
      anexoId = await (db.transaction as (
        fn: (tx: unknown) => Promise<number>,
      ) => Promise<number>)(
        async (tx) => {
          const txDb = tx as typeof db
          const [insercao] = await txDb
            .insert(anexos)
            .values({
              tarefaId: tarefa.id,
              organizacaoId: tarefa.organizacaoId,
              nomeArquivo,
              mimeType,
              tamanhoBytes: conteudo.length,
              chaveArmazenamento,
              enviadoPorId: ctx.colaboradorId,
              criadoEm: agora,
            })
          anexoId = Number(insercao.insertId)

          // Histórico append-only: só INSERT, evento 'anexo' com o nome.
          await txDb
            .insert(historicoTarefas)
            .values({
              tarefaId: tarefa.id,
              tipoEvento: "anexo",
              deColaboradorId: ctx.colaboradorId,
              paraColaboradorId: null,
              mensagem: `Anexo adicionado: ${nomeArquivo}`,
              criadoEm: agora,
            })
          return anexoId
        },
      )
    } catch (erro) {
      // Não deixar arquivo órfão se a persistência do metadado falhar.
      await unlink(caminhoFisico).catch(() => undefined)
      throw erro
    }

    const nomes = await this.nomesColaboradores(db, [ctx.colaboradorId])

    return {
      id: anexoId,
      nomeArquivo,
      mimeType,
      tamanhoBytes: conteudo.length,
      enviadoPorId: ctx.colaboradorId,
      enviadoPorNome: nomes.get(ctx.colaboradorId) ?? "Colaborador",
      criadoEm: agora.toISOString(),
      chaveArmazenamento,
    }
  }

  // ==========================================================================
  // Listagem
  // ==========================================================================

  /**
   * GET .../anexos — anexos da tarefa (antigo → novo) com autor (nome) e
   * data. Somente usuários da organização da tarefa (row-level).
   */
  async listar(
    projeto: ProjetoResumo,
    ctx: ContextoSessaoAnexos,
    tarefaId: number,
  ): Promise<ItemAnexo[]> {
    const db = await this.dbDoProjeto(projeto)
    const tarefa = await this.carregarTarefaNoEscopo(
      db,
      tarefaId,
      ctx.organizacaoId,
    )

    const linhas = await db
      .select({
        id: anexos.id,
        nomeArquivo: anexos.nomeArquivo,
        mimeType: anexos.mimeType,
        tamanhoBytes: anexos.tamanhoBytes,
        chaveArmazenamento: anexos.chaveArmazenamento,
        enviadoPorId: anexos.enviadoPorId,
        criadoEm: anexos.criadoEm,
      })
      .from(anexos)
      .where(
        and(
          eq(anexos.tarefaId, tarefa.id),
          eq(anexos.organizacaoId, tarefa.organizacaoId),
        ),
      )
      .orderBy(asc(anexos.criadoEm), asc(anexos.id))

    const ids = [...new Set(linhas.map((l) => Number(l.enviadoPorId)))]
    const nomes = await this.nomesColaboradores(db, ids)

    return linhas.map((l) => {
      const enviadoPorId = Number(l.enviadoPorId)
      return {
        id: Number(l.id),
        nomeArquivo: l.nomeArquivo,
        mimeType: l.mimeType ?? null,
        tamanhoBytes: l.tamanhoBytes == null ? null : Number(l.tamanhoBytes),
        enviadoPorId,
        enviadoPorNome: nomes.get(enviadoPorId) ?? "Colaborador",
        criadoEm: (l.criadoEm as Date).toISOString(),
        chaveArmazenamento: l.chaveArmazenamento,
      }
    })
  }

  // ==========================================================================
  // Download / preview
  // ==========================================================================

  /**
   * GET .../anexos/:anexoId/download | /preview — lê o arquivo de ANEXOS_DIR
   * e devolve um StreamableFile. Inline SOMENTE para png/jpeg/pdf; demais
   * tipos vão attachment (download do texto continua seguro).
   */
  async baixar(
    projeto: ProjetoResumo,
    ctx: ContextoSessaoAnexos,
    tarefaId: number,
    anexoId: number,
  ): Promise<StreamableFile> {
    const db = await this.dbDoProjeto(projeto)
    const anexo = await this.carregarAnexoNoEscopo(
      db,
      anexoId,
      ctx.organizacaoId,
    )
    // Consistência com a rota: o anexo precisa pertencer à tarefa informada.
    if (anexo.tarefaId !== tarefaId) {
      throw new NotFoundException("Anexo não encontrado nesta organização.")
    }

    let conteudo: Buffer
    try {
      conteudo = await readFile(this.caminhoFisicoDaChave(anexo.chaveArmazenamento))
    } catch (erro) {
      if (erro instanceof NotFoundException) throw erro
      this.logger.error(
        `Falha ao ler anexo ${anexoId} do armazenamento: ${String(erro)}`,
      )
      throw new NotFoundException("Arquivo do anexo não disponível no armazenamento.")
    }

    const mimeType = anexo.mimeType ?? "application/octet-stream"
    const modo = MIMES_INLINE.has(mimeType) ? "inline" : "attachment"
    return new StreamableFile(conteudo, {
      type: mimeType,
      // Inline SOMENTE para image/png, image/jpeg e application/pdf.
      // O nome vai na própria Content-Disposition (StreamableFile não tem
      // opção `filename` nesta versão do Nest).
      disposition: `${modo}; filename="${anexo.nomeArquivo}"`,
      length: conteudo.length,
    })
  }

  // ==========================================================================
  // Auxiliares
  // ==========================================================================

  /** Nomes dos colaboradores (mesma organização — FK garante o vínculo). */
  private async nomesColaboradores(
    db: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    ids: number[],
  ): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map()
    const resultados = await db
      .select({ id: colaboradores.id, nome: colaboradores.nome })
      .from(colaboradores)
      .where(inArray(colaboradores.id, ids))
    return new Map(resultados.map((l) => [Number(l.id), l.nome]))
  }
}
