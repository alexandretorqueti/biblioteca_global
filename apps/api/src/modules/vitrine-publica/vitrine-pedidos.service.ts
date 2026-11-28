/**
 * VitrinePedidosService — backend público do autoatendimento da vitrine
 * (vitrine-ia — macro #10, posição 3/11 — subtarefa 1; REQ-F-004/REQ-F-015).
 *
 * POST (criação): o pedido nasce SEMPRE `status = 'criado'` — nada do
 * payload seleciona projeto, tabela, planoId ou status:
 * - `dados` (JSON do multipart) valida no contrato strict
 *   `vitrinePedidoDadosSchema` (obrigatórios, e-mail, telefone pela regra da
 *   plataforma `isValidBrPhone`, maxLengths do schema.ts, ciclo,
 *   consentimentoLgpd literal true; chaves de fluxo/id/planoId reprovam);
 * - `plano` resolve POR NOME → planoId SOMENTE de plano ativo (400 se não
 *   existe/inativo) — o backend é a fonte única;
 * - upload no padrão `gestao-tarefas-global-anexos`: arquivos em memória
 *   (multer) + whitelist extensão×MIME no service (pdf/docx/txt; fora da
 *   whitelist → 400) + limite de bytes `VITRINE_UPLOAD_MAX_BYTES` (400
 *   citando o máximo) + gravação em disco sob `VITRINE_DOCUMENTOS_DIR` com
 *   chave LÓGICA `pedido/{uuid}/{uuid}.{ext}` — o caminho físico nunca sai
 *   do service;
 * - `textoLivre` não vazio vira documento `texto_livre` com o texto gravado
 *   no banco (fonte única), sem arquivo em disco;
 * - atômico: pedido + documentos na MESMA transação; em falha, os arquivos
 *   já gravados são removidos (nenhum pedido existe com documentos
 *   incompletos nem arquivo órfão);
 * - `token_acompanhamento` = 32 bytes criptograficamente aleatórios em hex
 *   (coluna unique) — única forma de acompanhar o pedido.
 *
 * GET (acompanhamento): somente o pedido do token (404 para token
 * inexistente/fora do formato — sem distinguir um caso do outro); resposta
 * por allow-list + parse strict `vitrinePedidoAcompanhamentoSchema`
 * (nenhum id, caminhoArmazenamento, textoExtraido, pagamentoId, linkAgente,
 * scriptEmbed). NÃO existe listagem pública de pedidos.
 *
 * Resolução do banco 100% server-side (slug fixo → CORE_DB →
 * ProjectDbFactory), reutilizando `VitrinePublicaService.obterDbProjeto`.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, extname, resolve, sep } from "node:path"
import { and, asc, eq } from "drizzle-orm"
import { ZodError } from "zod"
import {
  VITRINE_TOKEN_ACOMPANHAMENTO_REGEX,
  vitrinePedidoAcompanhamentoSchema,
  vitrinePedidoCriacaoRespostaSchema,
  vitrinePedidoDadosSchema,
  vitrinePedidoTextoLivreSchema,
  type VitrinePedidoAcompanhamento,
  type VitrinePedidoCriacaoResposta,
  type VitrineDocumentoTipoConteudo,
} from "@biblioteca-global/shared"
import {
  documentos,
  pedidos,
  planos as planosTable,
} from "../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { EnvService } from "../../config/env.service"
import { VitrinePublicaService } from "./vitrine-publica.service"
import { VITRINE_MAX_ARQUIVOS_POR_PEDIDO } from "./vitrine-pedidos.constantes"

/**
 * Arquivo multipart do @nestjs/platform-express (multer memoryStorage).
 * Tipagem local proposital — padrão `gestao-tarefas-global-anexos` (sem
 * `@types/multer`, dependência nova proibida).
 */
export interface ArquivoVitrineMultipart {
  originalname?: string
  filename?: string
  mimetype?: string
  size?: number
  buffer?: Buffer
}

/** MIME canônico por extensão binária (validação extensão×MIME dupla defesa). */
const MIMES_BINARIOS_POR_EXTENSAO: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

/** Extensões aceitas no formulário de conhecimento (ESPEC-CRUD §documentos). */
const EXTENSOES_PERMITIDAS = new Set<string>(["pdf", "docx", "txt"])

const MENSAGEM_TIPO_NAO_PERMITIDO =
  "Tipo de arquivo não permitido. Aceitos: PDF (application/pdf), " +
  "DOCX (documento Word) e TXT (texto puro)."

/**
 * Sanitiza o nome enviado: `basename` elimina path traversal
 * (`../../etc/x` → `x`) e caracteres fora do conjunto seguro viram `_`
 * (mesma regra do módulo de anexos — o nome volta ao cliente no
 * acompanhamento, então precisa ser inofensivo).
 */
function nomeArquivoSeguro(nomeOriginal: string): string {
  const semCaminho = basename((nomeOriginal ?? "").replace(/\\/g, "/"))
  const sanitizado = semCaminho.replace(/[^a-zA-Z0-9._-]/g, "_")
  return (sanitizado.length > 0 ? sanitizado : "arquivo").slice(0, 255)
}

/** Resultado da validação de um arquivo aceito (pronto para gravar). */
interface ArquivoAceito {
  nomeOriginal: string
  mimeType: string
  tipoConteudo: VitrineDocumentoTipoConteudo
  buffer: Buffer
}

/**
 * Whitelist extensão×MIME no service (padrão anexos): extensão do nome
 * sanitizado define o tipo; MIME declarado, quando presente, precisa
 * conferir (binários exigem o MIME exato; txt exige `text/*`).
 */
function validarArquivo(arquivo: ArquivoVitrineMultipart): ArquivoAceito {
  if (!arquivo || !arquivo.buffer) {
    throw new BadRequestException(
      "Arquivo recebido sem conteúdo — reenvie o campo 'arquivos' em multipart/form-data.",
    )
  }
  const nomeOriginal = nomeArquivoSeguro(arquivo.originalname ?? arquivo.filename ?? "")
  const extensao = extname(nomeOriginal).replace(/^\./, "").toLowerCase()
  if (!EXTENSOES_PERMITIDAS.has(extensao)) {
    throw new BadRequestException(MENSAGEM_TIPO_NAO_PERMITIDO)
  }
  if (arquivo.buffer.length === 0) {
    throw new BadRequestException(`Arquivo "${nomeOriginal}" está vazio.`)
  }
  const mime = (arquivo.mimetype ?? "").trim().toLowerCase()
  let mimeType: string
  if (extensao === "txt") {
    if (mime !== "" && !mime.startsWith("text/")) {
      throw new BadRequestException(MENSAGEM_TIPO_NAO_PERMITIDO)
    }
    mimeType = mime !== "" ? mime : "text/plain"
  } else {
    const mimeBinario = MIMES_BINARIOS_POR_EXTENSAO[extensao]
    if (mime !== "" && mime !== mimeBinario) {
      throw new BadRequestException(MENSAGEM_TIPO_NAO_PERMITIDO)
    }
    mimeType = mimeBinario
  }
  return {
    nomeOriginal,
    mimeType,
    tipoConteudo: extensao as VitrineDocumentoTipoConteudo,
    buffer: arquivo.buffer,
  }
}

/** ZodError → mensagem clara (campo: motivo) para o 400 do cliente final. */
function descreverErrosZod(erro: ZodError): string {
  return erro.issues
    .slice(0, 5)
    .map((issue) => {
      // strict: chave não reconhecida (ex.: status/planoId no payload) —
      // o issue.carrega a lista em `keys` com path vazio no zod v4.
      const bruto = issue as unknown as { code?: string; keys?: string[] }
      if (bruto.code === "unrecognized_keys" && Array.isArray(bruto.keys)) {
        return `chave não permitida: ${bruto.keys.map((k) => `"${k}"`).join(", ")}`
      }
      return `${issue.path.join(".") || "payload"}: ${issue.message}`
    })
    .join("; ")
}

@Injectable()
export class VitrinePedidosService {
  private readonly logger = new Logger(VitrinePedidosService.name)

  constructor(
    private readonly vitrine: VitrinePublicaService,
    private readonly env: EnvService,
  ) {}

  // ==========================================================================
  // Criação (POST /api/vitrine/pedidos)
  // ==========================================================================

  /**
   * Cria o pedido `criado` com documentos: valida TUDO antes do primeiro
   * efeito, grava arquivos em disco (chave lógica por pedido) e persiste
   * pedido + documentos na MESMA transação. Em falha de persistência, os
   * arquivos gravados são removidos — o pedido só existe completo.
   */
  async criar(
    dadosBruto: unknown,
    textoLivreBruto: unknown,
    arquivosBrutos: readonly ArquivoVitrineMultipart[] | undefined,
  ): Promise<VitrinePedidoCriacaoResposta> {
    // 1) `dados` — JSON do multipart no contrato strict (chaves de fluxo
    //    como status/pagamentoId/linkAgente/scriptEmbed/id/planoId reprovam
    //    aqui, antes de qualquer efeito).
    const dados = this.parseDados(dadosBruto)

    // 2) texto livre (opcional; não vazio vira documento texto_livre).
    const textoLivre = this.parseTextoLivre(textoLivreBruto)

    // 3) arquivos: quantidade, whitelist extensão×MIME e limite de bytes.
    const arquivos = arquivosBrutos ?? []
    if (arquivos.length > VITRINE_MAX_ARQUIVOS_POR_PEDIDO) {
      throw new BadRequestException(
        `Máximo de ${VITRINE_MAX_ARQUIVOS_POR_PEDIDO} arquivos por pedido.`,
      )
    }
    const maxBytes = this.env.vitrineUploadMaxBytes
    const aceitos = arquivos.map(validarArquivo)
    for (const item of aceitos) {
      if (item.buffer.length > maxBytes) {
        throw new BadRequestException(
          `Arquivo "${item.nomeOriginal}" excede o limite de ${maxBytes} bytes ` +
            `(máximo permitido por arquivo).`,
        )
      }
    }

    // 4) plano por NOME → id SOMENTE de plano ativo (WHERE ativo no SQL —
    //    mesma invariantes do conteúdo público; fonte única server-side).
    const db = await this.vitrine.obterDbProjeto()
    const plano = (
      await db
        .select({ id: planosTable.id })
        .from(planosTable)
        .where(and(eq(planosTable.nome, dados.plano), eq(planosTable.ativo, true)))
        .limit(1)
    ).at(0)
    if (!plano) {
      throw new BadRequestException(
        `Plano "${dados.plano}" não está disponível. Selecione um plano ativo.`,
      )
    }

    // 5) token de acompanhamento — 32 bytes criptograficamente aleatórios.
    const tokenAcompanhamento = randomBytes(32).toString("hex")

    // 6) gravação em disco sob VITRINE_DOCUMENTOS_DIR com chave LÓGICA por
    //    pedido (`pedido/{uuid}/{uuid}.{ext}`) — o caminho físico nunca sai.
    const chavePedido = randomUUID()
    const caminhosEscritos: string[] = []
    const linhasDocumentos: Array<Record<string, unknown>> = []
    try {
      for (const item of aceitos) {
        const chaveArmazenamento = `pedido/${chavePedido}/${randomUUID()}.${item.tipoConteudo}`
        const caminhoFisico = this.caminhoFisicoDaChave(chaveArmazenamento)
        await mkdir(dirname(caminhoFisico), { recursive: true })
        // "wx": nunca sobrescreve (a chave tem uuid; colisão é inaceitável).
        await writeFile(caminhoFisico, item.buffer, { flag: "wx" })
        caminhosEscritos.push(caminhoFisico)
        linhasDocumentos.push({
          nomeOriginal: item.nomeOriginal,
          mimeType: item.mimeType,
          tamanhoBytes: item.buffer.length,
          caminhoArmazenamento: chaveArmazenamento,
          tipoConteudo: item.tipoConteudo,
        })
      }
    } catch (erro) {
      await this.removerArquivos(caminhosEscritos)
      if (erro instanceof BadRequestException) throw erro
      this.logger.error(`Falha ao gravar documentos do pedido em disco: ${String(erro)}`)
      throw new BadRequestException(
        "Falha ao armazenar os arquivos no servidor. Tente novamente.",
      )
    }

    // 7) texto livre → documento texto_livre com o texto gravado no banco
    //    (não é arquivo — fica na fonte única, nunca exposto na resposta).
    if (textoLivre !== null) {
      linhasDocumentos.push({
        nomeOriginal: null,
        mimeType: "text/plain",
        tamanhoBytes: Buffer.byteLength(textoLivre, "utf8"),
        caminhoArmazenamento: null,
        tipoConteudo: "texto_livre",
        textoExtraido: textoLivre,
      })
    }

    // 8) pedido + documentos na MESMA transação (atômico — padrão anexos).
    const agora = new Date()
    try {
      await (db.transaction as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(
        async (tx) => {
          const txDb = tx as typeof db
          const [insercao] = await txDb.insert(pedidos).values({
            nomeNegocio: dados.nomeNegocio,
            nomeContato: dados.nomeContato,
            email: dados.email,
            telefone: dados.telefone,
            planoId: Number(plano.id),
            ciclo: dados.ciclo,
            informacoesNegocio: dados.informacoesNegocio ?? null,
            // Fonte única: status SEMPRE 'criado' — nunca do payload.
            status: "criado",
            consentimentoLgpd: true,
            tokenAcompanhamento,
            criadoEm: agora,
            emAtualizacao: agora,
          })
          const pedidoId = Number(insercao.insertId)
          if (linhasDocumentos.length > 0) {
            await txDb
              .insert(documentos)
              .values(linhasDocumentos.map((linha) => ({ pedidoId, ...linha })))
          }
        },
      )
    } catch (erro) {
      // Não deixar arquivo órfão se a persistência falhou (rollback da tx).
      await this.removerArquivos(caminhosEscritos)
      throw erro
    }

    // Barreira final: a resposta SÓ sai no contrato strict (token +
    // confirmação — nada de id interno).
    return vitrinePedidoCriacaoRespostaSchema.parse({
      tokenAcompanhamento,
      status: "criado",
      criadoEm: agora.toISOString(),
      mensagem:
        "Pedido recebido. Guarde o token de acompanhamento — ele é a única " +
        "forma de consultar o seu pedido.",
    })
  }

  /** `dados` do multipart: aceita JSON string (padrão) ou objeto (defesa). */
  private parseDados(dadosBruto: unknown): ReturnType<typeof vitrinePedidoDadosSchema.parse> {
    if (dadosBruto === undefined || dadosBruto === null || dadosBruto === "") {
      throw new BadRequestException(
        "Campo 'dados' ausente — envie o JSON do pedido em multipart/form-data.",
      )
    }
    let payload: unknown = dadosBruto
    if (typeof dadosBruto === "string") {
      try {
        payload = JSON.parse(dadosBruto)
      } catch {
        throw new BadRequestException("Campo 'dados' não é um JSON válido.")
      }
    }
    try {
      return vitrinePedidoDadosSchema.parse(payload)
    } catch (erro) {
      if (erro instanceof ZodError) {
        throw new BadRequestException(`Dados do pedido inválidos — ${descreverErrosZod(erro)}.`)
      }
      throw erro
    }
  }

  /** `textoLivre` do multipart: ausente/vazio → null; não vazio → texto. */
  private parseTextoLivre(textoLivreBruto: unknown): string | null {
    if (textoLivreBruto === undefined || textoLivreBruto === null) return null
    if (typeof textoLivreBruto !== "string") {
      throw new BadRequestException("Campo 'textoLivre' deve ser texto.")
    }
    const texto = textoLivreBruto.trim()
    if (texto === "") return null
    try {
      vitrinePedidoTextoLivreSchema.parse(texto)
    } catch (erro) {
      if (erro instanceof ZodError) {
        throw new BadRequestException(`Texto livre inválido — ${descreverErrosZod(erro)}.`)
      }
      throw erro
    }
    return texto
  }

  // ==========================================================================
  // Acompanhamento (GET /api/vitrine/pedidos/:token)
  // ==========================================================================

  /**
   * Somente o pedido do token: dados do negócio, nome do plano, ciclo,
   * status e metadados dos documentos (allow-list + parse strict). Token
   * fora do formato ou inexistente → 404 idêntico (não revela existência).
   */
  async acompanhar(token: string): Promise<VitrinePedidoAcompanhamento> {
    if (!VITRINE_TOKEN_ACOMPANHAMENTO_REGEX.test(token ?? "")) {
      throw new NotFoundException("Pedido não encontrado.")
    }
    const db = await this.vitrine.obterDbProjeto()
    const linha = (
      await db
        .select({
          id: pedidos.id,
          nomeNegocio: pedidos.nomeNegocio,
          nomeContato: pedidos.nomeContato,
          email: pedidos.email,
          telefone: pedidos.telefone,
          informacoesNegocio: pedidos.informacoesNegocio,
          planoNome: planosTable.nome,
          ciclo: pedidos.ciclo,
          status: pedidos.status,
          criadoEm: pedidos.criadoEm,
        })
        .from(pedidos)
        .innerJoin(planosTable, eq(planosTable.id, pedidos.planoId))
        .where(eq(pedidos.tokenAcompanhamento, token))
        .limit(1)
    ).at(0)
    if (!linha) {
      throw new NotFoundException("Pedido não encontrado.")
    }

    const docs = await db
      .select({
        nomeOriginal: documentos.nomeOriginal,
        tipoConteudo: documentos.tipoConteudo,
        tamanhoBytes: documentos.tamanhoBytes,
      })
      .from(documentos)
      .where(eq(documentos.pedidoId, Number(linha.id)))
      .orderBy(asc(documentos.id))

    // Barreira final: nada interno (id, caminhoArmazenamento, textoExtraido,
    // pagamentoId, linkAgente, scriptEmbed) sobrevive ao contrato strict.
    return vitrinePedidoAcompanhamentoSchema.parse({
      nomeNegocio: linha.nomeNegocio,
      nomeContato: linha.nomeContato,
      email: linha.email,
      telefone: linha.telefone,
      informacoesNegocio: linha.informacoesNegocio ?? null,
      planoNome: linha.planoNome,
      ciclo: linha.ciclo,
      status: linha.status,
      criadoEm: (linha.criadoEm as Date).toISOString(),
      documentos: docs.map((doc) => ({
        nomeOriginal: doc.nomeOriginal ?? null,
        tipoConteudo: doc.tipoConteudo,
        tamanhoBytes: doc.tamanhoBytes == null ? null : Number(doc.tamanhoBytes),
      })),
    })
  }

  // ==========================================================================
  // Armazenamento (chave lógica — o caminho físico nunca sai daqui)
  // ==========================================================================

  /**
   * Resolve o caminho físico da chave lógica DENTRO do VITRINE_DOCUMENTOS_DIR
   * (com guarda contra escape) — padrão do módulo de anexos.
   */
  private caminhoFisicoDaChave(chaveArmazenamento: string): string {
    const diretorio = resolve(this.env.vitrineDocumentosDir)
    const caminho = resolve(diretorio, ...chaveArmazenamento.split("/"))
    if (caminho !== diretorio && !caminho.startsWith(diretorio + sep)) {
      throw new BadRequestException("Chave de armazenamento inválida.")
    }
    return caminho
  }

  /** Remove arquivos já gravados quando a persistência falha (sem órfãos). */
  private async removerArquivos(caminhos: readonly string[]): Promise<void> {
    await Promise.all(caminhos.map((caminho) => unlink(caminho).catch(() => undefined)))
  }
}
