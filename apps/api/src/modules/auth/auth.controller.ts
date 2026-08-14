/**
 * AuthController — rotas de autenticação (PoC §6.2).
 * login é pública; select-project/refresh/logout usam o refresh token;
 * me/change-password usam o access token do projeto.
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import type {
  LoginResponse,
  MeResponse,
  ProjetoResumo,
  RefreshResponse,
  SelectProjectResponse,
  UsuarioAutenticado,
} from "@biblioteca-global/shared"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { Public } from "../../common/decorators/public.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RefreshAuthGuard } from "../../common/guards/refresh-auth.guard"
import type { ApiRequest, ProjectScope } from "../../common/types"
import { AuthService } from "./auth.service"
// DTOs precisam de import de VALOR (não apenas tipo): o ValidationPipe
// resolve a classe em runtime via metadata de parâmetro.
import { ChangePasswordDto } from "./dto/change-password.dto"
import { LoginDto } from "./dto/login.dto"
import { SelectProjectDto } from "./dto/select-project.dto"

function sessaoRefreshDe(req: ApiRequest) {
  if (!req.refreshSession) {
    throw new InternalServerErrorException(
      "Sessão de refresh não resolvida — use RefreshAuthGuard antes",
    )
  }
  return req.refreshSession
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  /** Rate limit reforçado no login (anti força bruta — PoC §5.2/§11). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.authService.login(dto)
  }

  @UseGuards(RefreshAuthGuard)
  @Post("select-project")
  selectProject(
    @Req() req: ApiRequest,
    @Body() dto: SelectProjectDto,
  ): Promise<SelectProjectResponse> {
    return this.authService.selectProject(
      sessaoRefreshDe(req).usuarioId,
      dto,
    )
  }

  @UseGuards(RefreshAuthGuard)
  @Post("refresh")
  refresh(@Req() req: ApiRequest): Promise<RefreshResponse> {
    return this.authService.refresh(sessaoRefreshDe(req).token)
  }

  @UseGuards(RefreshAuthGuard)
  @Post("logout")
  async logout(@Req() req: ApiRequest): Promise<{ ok: boolean }> {
    await this.authService.logout(sessaoRefreshDe(req).token)
    return { ok: true }
  }

  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  @Get("me")
  me(
    @CurrentUser() usuario: UsuarioAutenticado,
    @CurrentProject() projeto: ProjetoResumo,
  ): MeResponse {
    const scope: ProjectScope = { usuario, projeto }
    return this.authService.me(scope)
  }

  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  @Post("change-password")
  async changePassword(
    @CurrentUser() usuario: UsuarioAutenticado,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: boolean }> {
    await this.authService.changePassword(usuario.id, dto)
    return { ok: true }
  }
}
