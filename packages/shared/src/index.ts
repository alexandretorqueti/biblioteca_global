/**
 * @biblioteca-global/shared — contratos únicos entre front e back.
 * Exports explícitos; nenhum tipo `any` (regra do projeto).
 */

// Tipos base de entidade/transporte
export type {
  CadastroDataSource,
  CrudOrderByItem,
  EntityRecord,
  FieldValues,
  ListParams,
  PaginatedResult,
  ApiError,
} from "./entity"

// Campos de formulário serializáveis
export {
  RESOURCE_NAME_REGEX,
  dynamicFieldTypeSchema,
  dynamicFieldOptionSchema,
  multipleChoiceFieldConfigSchema,
  dynamicFieldConfigSchema,
} from "./field"
export type {
  DynamicFieldType,
  DynamicFieldOption,
  MultipleChoiceFieldConfig,
  DynamicFieldConfig,
} from "./field"

// Config serializável do GeradorSistema
export {
  geradorSistemaAppConfigSchema,
  cadastroOverridesConfigSchema,
  cadastroScreenConfigSchema,
  customScreenConfigSchema,
  editScreenConfigSchema,
  externalScreenConfigSchema,
  relatedScreenSchema,
  childScreenSchema,
  childRouteSchema,
  customActionSchema,
  screenConfigSchema,
  geradorSistemaRouteSchema,
  geradorSistemaGroupSchema,
  geradorSistemaConfigSchema,
} from "./config"
export type {
  GeradorSistemaAppConfig,
  CadastroOverridesConfig,
  CadastroScreenConfig,
  CustomScreenConfig,
  ExternalScreenConfig,
  EditScreenConfig,
  RelatedScreen,
  ChildScreen,
  ChildRoute,
  CustomAction,
  RowActionConfig,
  ScreenConfig,
  GeradorSistemaRoute,
  GeradorSistemaGroup,
  GeradorSistemaConfig,
} from "./config"

// Auth e sessão
export {
  loginIdentifierTypeSchema,
  perfilSchema,
  loginRequestSchema,
  selectProjectRequestSchema,
  changePasswordRequestSchema,
  requestCodeRequestSchema,
  verifyCodeRequestSchema,
  setPasswordRequestSchema,
} from "./auth"
export type {
  LoginIdentifierType,
  Perfil,
  LoginRequest,
  SelectProjectRequest,
  ChangePasswordRequest,
  RequestCodeRequest,
  VerifyCodeRequest,
  SetPasswordRequest,
  RequestCodeResponse,
  VerifyCodeResponse,
  SetPasswordResponse,
  ProvisionProjectRequest,
  ProvisionProjectResponse,
  ProjetoResumo,
  LoginResponse,
  SelectProjectResponse,
  RefreshResponse,
  AccessTokenClaims,
  AuthTokenClaims,
  UsuarioAutenticado,
  SessionInfo,
  MeResponse,
} from "./auth"

// Entidades do core
export type { Usuario, Projeto, ProjetoUsuario } from "./core"

// Seleção de modelos de IA por projeto/tipo de agente (espelha o contrato do motor)
export {
  ModelSelectionTipoSchema,
  ModelSelectionEntrySchema,
  ProjectModelSelectionSchema,
} from "./model-selection"

// Eventos de execução em tempo real
export {
  taskExecutionEventSchema,
  taskEventEnvelopeSchema,
  realtimeClientMessageSchema,
  realtimeServerMessageSchema,
} from "./realtime"
export type {
  TaskExecutionEvent,
  TaskEventEnvelope,
  RealtimeClientMessage,
  RealtimeServerMessage,
} from "./realtime"
export type {
  ModelSelectionTipo,
  ModelSelectionEntry,
  ProjectModelSelection,
} from "./model-selection"
