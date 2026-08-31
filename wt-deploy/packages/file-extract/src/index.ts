/**
 * Extração de texto de arquivos anexados ao chat.
 *
 * PDF/DOCX são formatos binários: o modelo lê texto, não bytes.
 * Este módulo converte o conteúdo binário em texto utilizável.
 *
 * Formatos suportados:
 *   - text/plain (txt, md, csv...): texto cru
 *   - application/pdf: PDF — extração direta (pdf-parse)
 *   - docx: extrai texto do XML (mammoth)
 *   - imagens: não extraímos texto (OCR futuro)
 */

/** Resultado da extração para um arquivo. */
export interface ExtractResult {
  ok: boolean
  text: string
  kind: "pdf" | "docx" | "text" | "image" | "unsupported" | "empty"
  message?: string
}

/** Detecta o formato a partir do nome + tipo MIME (e dos primeiros bytes). */
export function detectFileKind(
  name: string,
  mime: string | undefined,
  buffer: Uint8Array,
): ExtractResult["kind"] {
  const lower = name.toLowerCase()
  const head = Array.from(buffer.slice(0, 8))
  const isPdfMagic =
    head.length >= 4 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 // %PDF
  const isZipMagic =
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04 // PK\x03\x04

  if (isPdfMagic || /\.pdf$/i.test(lower) || mime === "application/pdf") return "pdf"
  if (
    lower.endsWith(".docx") ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (isZipMagic || !mime) return "docx"
    return "docx"
  }
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(lower) || /^image\//.test(mime ?? "")) return "image"
  if (isZipMagic) return "unsupported"
  if (/\.(txt|md|markdown|csv|json|log|rtf)$/i.test(lower) || /^text\//.test(mime ?? ""))
    return "text"
  return "unsupported"
}

/** Extrai o texto de um buffer PDF. */
async function extractPdf(buffer: Uint8Array): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default
  const result = await pdfParse(Buffer.from(buffer))
  return (result.text ?? "").trim()
}

/** Extrai o texto de um buffer DOCX via mammoth. */
async function extractDocx(buffer: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth")
  const bufferBin = Buffer.from(buffer)
  const result = await mammoth.extractRawText({ buffer: bufferBin })
  return result.value.trim()
}

/** Extrai o texto de um buffer textual (decodifica utf8). */
function extractTextBuffer(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("utf8").trim()
}

/**
 * Ponto de entrada: dado o arquivo (nome, mime, bytes), retorna o texto
 * extraído ou uma mensagem amigável explicando por que não foi possível.
 */
export async function extractTextFromFile(input: {
  name: string
  mime?: string
  data: Uint8Array
}): Promise<ExtractResult> {
  const { name, mime, data } = input
  if (!data || data.length === 0) {
    return { ok: false, text: "", kind: "empty", message: "O arquivo está vazio." }
  }
  const kind = detectFileKind(name, mime, data)

  switch (kind) {
    case "pdf":
      try {
        const text = await extractPdf(data)
        if (!text) {
          return {
            ok: false,
            text: "",
            kind: "pdf",
            message:
              "Este PDF não tem camada de texto extraível (parece ser escaneado/imagem). Para eu ler, reenvie como imagem (PNG/JPG) ou com texto selecionável.",
          }
        }
        return { ok: true, text, kind: "pdf" }
      } catch (err) {
        return {
          ok: false,
          text: "",
          kind: "pdf",
          message: `Não consegui ler este PDF (${err instanceof Error ? err.message : "erro"}). Envie em outro formato (texto, DOCX ou imagem).`,
        }
      }
    case "docx":
      try {
        const text = await extractDocx(data)
        if (!text)
          return {
            ok: false,
            text: "",
            kind: "docx",
            message: "Este documento DOCX está vazio ou sem texto de parágrafos.",
          }
        return { ok: true, text, kind: "docx" }
      } catch (err) {
        return {
          ok: false,
          text: "",
          kind: "docx",
          message: `Não consegui ler este DOCX (${err instanceof Error ? err.message : "erro"}). Converta para PDF ou cole o texto aqui.`,
        }
      }
    case "text":
      return { ok: true, text: extractTextBuffer(data), kind: "text" }
    case "image":
      return {
        ok: false,
        text: "",
        kind: "image",
        message:
          "Recebi a imagem, mas ainda não consigo ler seu conteúdo. Por favor, descreva o que ela mostra.",
      }
    case "unsupported":
    default:
      return {
        ok: false,
        text: "",
        kind: "unsupported",
        message:
          "Esse formato de arquivo eu ainda não consigo ler (aceito PDF, DOCX, TXT, MD, imagens). Pode colar o conteúdo como texto ou enviar em outro formato?",
      }
  }
}
