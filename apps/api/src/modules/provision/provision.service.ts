/**
 * ProvisionService — acesso automático do cliente ao projeto (auth única, D6).
 *
 * Regras (idempotente — pode rodar 2x sem quebrar):
 * 1. E-mail NÃO existe em usuarios → cria usuário SEM senha (entra por código).
 *    E-mail já existe → usa o existente, nunca duplica.
 * 2. Projeto (por slug) não existe → cria com ciclo de vida completo
 *    (registro + database + migrations via ProjetosService).
 * 3. Upsert do vínculo projetos_usuarios com perfil admin (dono do projeto).
 */
import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common"
import type {
  ProvisionProjectRequest,
  ProvisionProjectResponse,
} from "@biblioteca-global/shared"
import { AUTH_REPOSITORY, type AuthRepository } from "../auth/auth.repository"
import { isValidEmail } from "../auth/verification"
import {
  USUARIOS_REPOSITORY,
  type UsuariosRepository,
} from "../usuarios/usuarios.repository"
import {
  configPadrao,
  ProjetosService,
} from "../projetos/projetos.service"
import { validarSlug } from "../projetos/provisioner.service"

/** Slug derivado do nome do projeto (a-z0-9 e hífen, sem acentos). */
function slugDoNome(nome: string): string {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

@Injectable()
export class ProvisionService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly authRepo: AuthRepository,
    @Inject(USUARIOS_REPOSITORY)
    private readonly usuariosRepo: UsuariosRepository,
    @Inject(ProjetosService) private readonly projetosService: ProjetosService,
  ) {}

  async provisionProject(
    dto: ProvisionProjectRequest,
  ): Promise<ProvisionProjectResponse> {
    const email = dto.email.trim().toLowerCase()
    if (!isValidEmail(email)) {
      throw new BadRequestException("E-mail inválido")
    }

    // 1. Usuário: cria sem senha se não existir; nunca duplica.
    let usuario = await this.authRepo.findUsuarioByIdentifier("email", email)
    let criado = false
    if (!usuario) {
      const nome = dto.nome?.trim() || email.split("@")[0] || email
      const id = await this.usuariosRepo.criarUsuario({
        nome,
        email,
        passwordHash: null,
      })
      criado = true
      usuario = await this.authRepo.findUsuarioById(id)
      if (!usuario) {
        throw new Error("usuário não encontrado após a criação")
      }
    }

    // 2. Projeto: cria (ciclo completo) se o slug não existir.
    const nomeProjeto = dto.projetoNome.trim()
    const slug = dto.projetoSlug?.trim() || slugDoNome(nomeProjeto)
    if (!slug) {
      throw new BadRequestException("projetoSlug inválido — informe um slug ou nome válido")
    }
    try {
      validarSlug(slug)
    } catch {
      throw new BadRequestException(
        "projetoSlug inválido — deve começar com letra minúscula (a-z0-9 e hífen)",
      )
    }

    let projeto = await this.projetosService.detalharPorSlug(slug)
    if (!projeto) {
      const criadoProjeto = await this.projetosService.criar({
        nome: nomeProjeto,
        slug,
      })
      projeto = criadoProjeto
    }

    // 3. Vínculo admin (upsert).
    await this.usuariosRepo.criarVinculo(usuario.id, projeto.id, "admin")

    return {
      usuarioId: usuario.id,
      projetoId: projeto.id,
      perfil: "admin",
      criado,
    }
  }
}
