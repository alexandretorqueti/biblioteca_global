/**
 * ErroUploadVitrineFilter — converte `MulterError` (erros do parse
 * multipart do formulário público da vitrine) em ApiError 400 com mensagem
 * clara, no padrão de `gestao-tarefas-global-anexos/erro-upload.filter.ts`
 * (vitrine-ia — macro #10, posição 3/11 — subtarefa 1).
 *
 * - `LIMIT_FILE_SIZE` → 400 citando o máximo de `VITRINE_UPLOAD_MAX_BYTES`
 *   (mesma fonte do limite do interceptor e da validação do service);
 * - `LIMIT_FILE_COUNT` e demais `MulterError` → 400 "Upload inválido".
 *
 * ⚠️ Detalhe do Nest 11: o `transformException` do `@nestjs/platform-express`
 * converte `MulterError` de `LIMIT_FILE_SIZE` em `PayloadTooLargeException`
 * (413) ANTES de o erro chegar aos filtros — por isso o `@Catch` lista os
 * dois tipos (a rota é exclusivamente de upload, mapear 413→400 é seguro e
 * atende ao critério "400 citando o máximo").
 *
 * O `MulterError` vem do multer transitivo do @nestjs/platform-express com
 * tipagem local (gestao-tarefas-global-anexos/multer.d.ts) — sem
 * @types/multer (dependência nova proibida).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from "@nestjs/common"
import { MulterError } from "multer"
import { limiteUploadVitrineBytes } from "./vitrine-pedidos.constantes"

interface HttpResponse {
  status(code: number): HttpResponse
  json(body: unknown): HttpResponse
}

@Catch(MulterError, PayloadTooLargeException)
export class ErroUploadVitrineFilter implements ExceptionFilter {
  catch(exception: MulterError | PayloadTooLargeException, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const resposta = http.getResponse<HttpResponse>()
    const limite = limiteUploadVitrineBytes()

    let mensagem: string
    let detalhes: string
    if (exception instanceof HttpException && exception.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) {
      // LIMIT_FILE_SIZE já transformado pelo platform-express em 413.
      mensagem = `Arquivo excede o limite de ${limite} bytes (máximo permitido por arquivo).`
      detalhes = "Limite de tamanho aplicado pelo parse de upload (LIMIT_FILE_SIZE)."
    } else {
      const codigo = (exception as MulterError).code
      mensagem =
        codigo === "LIMIT_FILE_SIZE"
          ? `Arquivo excede o limite de ${limite} bytes (máximo permitido por arquivo).`
          : `Upload inválido: ${exception.message}`
      detalhes = `Código de rejeição do upload: ${String(codigo ?? exception.message)}`
    }

    resposta.status(400).json({
      code: "VALIDATION_ERROR",
      message: mensagem,
      details: detalhes,
    })
  }
}
