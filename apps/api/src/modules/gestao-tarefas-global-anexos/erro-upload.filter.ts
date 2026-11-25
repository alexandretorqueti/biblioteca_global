/**
 * ErroUploadFilter — converte `MulterError` (erros do parse multipart) em
 * ApiError 400 com mensagem clara (gestao-de-tarefas-global — macro #6,
 * subtarefa 1).
 *
 * Sem este filtro, o `FileInterceptor` propaga o `MulterError` e o filtro
 * global trata como INTERNAL_ERROR (500). Com ele:
 * - `LIMIT_FILE_SIZE` → 400 "Arquivo excede o limite de N bytes (máximo
 *   permitido por anexo)" — o N vem de `ANEXOS_MAX_BYTES` (mesma fonte do
 *   limite do interceptor e da validação canônica do service);
 * - demais `MulterError` → 400 "Upload inválido" (o payload multipart foi
 *   malformado — responsabilidade do cliente).
 *
 * O `MulterError` vem do multer transitivo do @nestjs/platform-express com
 * tipagem local (multer.d.ts) — sem @types/multer (dependência nova proibida).
 */
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common"
import { MulterError } from "multer"
import { limiteUploadAnexoBytes } from "./anexos.constantes"

interface HttpResponse {
  status(code: number): HttpResponse
  json(body: unknown): HttpResponse
}

@Catch(MulterError)
export class ErroUploadFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const resposta = http.getResponse<HttpResponse>()
    const limite = limiteUploadAnexoBytes()

    const mensagem =
      exception.code === "LIMIT_FILE_SIZE"
        ? `Arquivo excede o limite de ${limite} bytes (máximo permitido por anexo).`
        : `Upload inválido: ${exception.message}`

    resposta.status(400).json({
      code: "VALIDATION_ERROR",
      message: mensagem,
      details: `Código de rejeição do upload: ${exception.code}`,
    })
  }
}
