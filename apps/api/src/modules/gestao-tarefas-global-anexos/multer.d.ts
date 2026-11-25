/**
 * Tipagem LOCAL mínima do pacote `multer` (transitivo do
 * @nestjs/platform-express). `@types/multer` é dependência nova — proibida
 * pelo escopo; este arquivo declara apenas o que o módulo de anexos usa.
 */
declare module "multer" {
  export class MulterError extends Error {
    code: string
    constructor(code: string, message?: string)
  }
  export function memoryStorage(): unknown
  export function diskStorage(options: unknown): unknown
}
