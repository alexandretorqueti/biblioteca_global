/**
 * Tipos das entidades do database core (espelho das tabelas — PoC §4.2).
 * A validação de escrita vem do drizzle-zod (derivado do schema) nas
 * etapas de backend; aqui ficam os contratos de leitura entre front e back.
 */
import type { GeradorSistemaConfig } from "./config"
import type { Perfil } from "./auth"

export interface Usuario {
  id: number
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
  nome: string
  ativo: boolean
  createdAt: string
  updatedAt: string
}

export interface Projeto {
  id: number
  nome: string
  slug: string
  ativo: boolean
  /** Config corrente do GeradorSistema (iniciada igual à base versionada). */
  config: GeradorSistemaConfig
  createdAt: string
  updatedAt: string
}

/** Vínculo N:N usuário ↔ projeto (perfil por projeto). */
export interface ProjetoUsuario {
  projetoId: number
  usuarioId: number
  perfil: Perfil
  createdAt: string
}
