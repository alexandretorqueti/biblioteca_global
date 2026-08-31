import { SetMetadata } from "@nestjs/common"

export const IS_PUBLIC_KEY = "auth:public"

/** Marca a rota como pública (sem autenticação). */
export const Public = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_PUBLIC_KEY, true)
