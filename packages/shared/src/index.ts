/**
 * @biblioteca-global/shared — contratos únicos entre front e back.
 * Exports explícitos; nenhum tipo `any` (regra do projeto).
 */

// Tipos base de entidade/transporte
export type {
  CadastroDataSource,
  EntityRecord,
  FieldValues,
  ListParams,
  PaginatedResult,
  ApiError,
} from "./entity.js"

// Campos de formulário serializáveis
export {
  dynamicFieldTypeSchema,
  dynamicFieldOptionSchema,
  multipleChoiceFieldConfigSchema,
  dynamicFieldConfigSchema,
} from "./field.js"
export type {
  DynamicFieldType,
  DynamicFieldOption,
  MultipleChoiceFieldConfig,
  DynamicFieldConfig,
} from "./field.js"

// Config serializável do GeradorSistema
export {
  geradorSistemaAppConfigSchema,
  cadastroOverridesConfigSchema,
  cadastroScreenConfigSchema,
  customScreenConfigSchema,
  screenConfigSchema,
  geradorSistemaRouteSchema,
  geradorSistemaGroupSchema,
  geradorSistemaConfigSchema,
} from "./config.js"
export type {
  GeradorSistemaAppConfig,
  CadastroOverridesConfig,
  CadastroScreenConfig,
  CustomScreenConfig,
  ScreenConfig,
  GeradorSistemaRoute,
  GeradorSistemaGroup,
  GeradorSistemaConfig,
} from "./config.js"

// Auth e sessão
export {
  loginIdentifierTypeSchema,
  perfilSchema,
  loginRequestSchema,
  selectProjectRequestSchema,
  changePasswordRequestSchema,
} from "./auth.js"
export type {
  LoginIdentifierType,
  Perfil,
  LoginRequest,
  SelectProjectRequest,
  ChangePasswordRequest,
  ProjetoResumo,
  LoginResponse,
  SelectProjectResponse,
  RefreshResponse,
  AccessTokenClaims,
  UsuarioAutenticado,
  SessionInfo,
  MeResponse,
} from "./auth.js"

// Entidades do core
export type { Usuario, Projeto, ProjetoUsuario } from "./core.js"
