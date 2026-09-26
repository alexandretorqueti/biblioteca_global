import { SetMetadata } from "@nestjs/common"
import type { Perfil } from "@biblioteca-global/shared"

export const ROLES_KEY = "***"

/** Restringe a rota aos perfis informados (checado pelo RolesGuard). */
export const Roles = (...perfis: Perfil[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, perfis)
