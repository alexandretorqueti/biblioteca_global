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
  mascararCpf,
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

// LGPD — consentimento e direitos do titular
export {
  consentimentoRequestSchema,
  consentimentoResponseSchema,
  consentimentoStatusSchema,
  usuarioConsentimentoSchema,
  usuarioVinculoExportSchema,
  usuarioDadosExportSchema,
  dadosExportResponseSchema,
  retificacaoRequestSchema,
  exclusaoResponseSchema,
} from "./lgpd"
export type {
  ConsentimentoRequest,
  ConsentimentoResponse,
  ConsentimentoStatus,
  UsuarioConsentimento,
  UsuarioVinculoExport,
  UsuarioDadosExport,
  DadosExportResponse,
  RetificacaoRequest,
  ExclusaoResponse,
} from "./lgpd"

// Entidades do core
export type { Usuario, Projeto, ProjetoUsuario } from "./core"

// Runtime público do chat por tenant (sem segredos, IDs internos ou prompt)
export { tenantChatConfigSchema, tenantChatConfigInputSchema, DEFAULT_TENANT_CHAT_CONFIG, normalizeTenantChatConfig } from "./tenant"
export type { TenantChatConfig } from "./tenant"

// Painel administrativo do tenant: conversas, leads, métricas, configuração e ingestão.
export {
  tenantConversaCanalSchema,
  tenantConversaStatusSchema,
  tenantConversasFiltrosSchema,
  filtrosConversasSchema,
  tenantConversaItemSchema,
  tenantConversaMensagemSchema,
  tenantConversaHistoricoSchema,
  tenantLeadsFiltrosSchema,
  tenantLeadItemSchema,
  tenantMetricasSchema,
  metricasTenantSchema,
  tenantToolAdminSchema,
  tenantConfigAdminViewSchema,
  tenantConfigAdminInputSchema,
  tenantConversaMensagemIngestaoSchema,
  tenantConversaIngestaoSchema,
  tenantLeadIngestaoSchema,
} from "./painel-tenant"
export type {
  TenantConversasFiltros,
  TenantConversaItem,
  TenantConversaMensagem,
  TenantConversaHistorico,
  TenantLeadsFiltros,
  TenantLeadItem,
  TenantMetricas,
  TenantConfigAdminView,
  TenantConfigAdminInput,
  TenantConversaIngestao,
  TenantLeadIngestao,
  TenantChatConfigAdmin,
  TenantTransbordoAdmin,
} from "./painel-tenant"

// Canal WhatsApp por tenant — vínculo, pareamento e contrato do gateway
export {
  tenantCanalWhatsappEstadoSchema,
  tenantCanalWhatsappSchema,
  iniciarPareamentoWhatsappRequestSchema,
  iniciarPareamentoWhatsappResponseSchema,
  statusPareamentoWhatsappResponseSchema,
  listarVinculosWhatsappResponseSchema,
  removerVinculoWhatsappResponseSchema,
  whatsappLoginStartResponseSchema,
  whatsappLoginWaitResponseSchema,
  whatsappGatewayStatusResponseSchema,
  whatsappProvisionRequestSchema,
  whatsappDeleteResponseSchema,
  normalizeBrPhone,
  isValidBrPhone,
  phoneSlug,
  telefoneSlug,
} from "./canais-whatsapp"
export type {
  TenantCanalWhatsappEstado,
  TenantCanalWhatsapp,
  IniciarPareamentoWhatsappRequest,
  IniciarPareamentoWhatsappResponse,
  StatusPareamentoWhatsappResponse,
  ListarVinculosWhatsappResponse,
  RemoverVinculoWhatsappResponse,
  WhatsappLoginStartResponse,
  WhatsappLoginWaitResponse,
  WhatsappGatewayStatusResponse,
  WhatsappProvisionRequest,
  WhatsappDeleteResponse,
} from "./canais-whatsapp"

// Auditoria dos logins bem-sucedidos.
export { logLoginMetodoSchema, logLoginSchema } from "./logs-login"
export type { LogLoginMetodo, LogLogin, LogsLoginPage } from "./logs-login"

// Seleção de modelos de IA por projeto/tipo de agente (espelha o contrato do motor)
export {
  ModelSelectionTipoSchema,
  ModelSelectionEntrySchema,
  ProjectModelSelectionSchema,
} from "./model-selection"

// Eventos de execução em tempo real
export {
  taskExecutionEventSchema,
  realtimeEventTypeSchema,
  agentMapSnapshotSchema,
  taskDetailSnapshotSchema,
  helpDeskRealtimeMessageSchema,
  helpDeskRealtimeSnapshotSchema,
  helpDeskRealtimeEventSchema,
  notificationRealtimeEventSchema,
  realtimeIngressEventSchema,
  taskEventEnvelopeSchema,
  realtimeClientMessageSchema,
  realtimeServerMessageSchema,
} from "./realtime"
export type {
  TaskExecutionEvent,
  RealtimeEventType,
  AgentMapSnapshot,
  TaskDetailSnapshot,
  HelpDeskRealtimeMessage,
  HelpDeskRealtimeSnapshot,
  NotificationRealtimeEvent,
  RealtimeIngressEvent,
  TaskEventEnvelope,
  RealtimeClientMessage,
  RealtimeServerMessage,
} from "./realtime"
export { REALTIME_REPLAY_UNAVAILABLE_CODE } from "./realtime"
export type {
  ModelSelectionTipo,
  ModelSelectionEntry,
  ProjectModelSelection,
} from "./model-selection"

// Chat genérico com agentes
export {
  agentInfoSchema,
  chatMessageRoleSchema,
  chatAttachmentSchema,
  chatMessageSchema,
  chatSessionSchema,
  startChatSessionInputSchema,
  sendChatMessageInputSchema,
  chatHistorySchema,
  sendChatMessageSuccessSchema,
  chatSendFailureReasonSchema,
  sendChatMessageFailureSchema,
  sendChatMessageResultSchema,
} from "./chat"

// Normalizador de conteúdo de chat (JSON → texto legível)
export { normalizeChatContent } from "./chat-normalizer"

// Forjador por API — contrato forjar-persona (isas-mt-04)
export {
  FORJAR_PERSONA_DESCRICAO_MIN,
  FORJAR_PERSONA_DESCRICAO_MAX,
  FORJAR_PERSONA_ARQUIVOS_MAX,
  FORJAR_PERSONA_ARQUIVO_MAX_BYTES,
  FORJAR_PERSONA_ARQUIVO_NOME_MAX,
  TENANT_SLUG_REGEX,
  MATERIAL_HASH_REGEX,
  forjarPersonaStatusSchema,
  forjarArquivoSchema,
  forjarPersonaRequestSchema,
  forjarPersonaResponseSchema,
} from "./forjador"
export type {
  ForjarPersonaStatus,
  ForjarArquivo,
  ForjarPersonaRequest,
  ForjarPersonaResponse,
} from "./forjador"

// HelpDesk persistido no core
export {
  helpDeskSessionStatusSchema,
  helpDeskSessionSchema,
  helpDeskMessageSchema,
  helpDeskSendMessageInputSchema,
  helpDeskHistorySchema,
} from "./helpdesk"

// Vitrine pública — contrato de `GET /api/vitrine/conteudo` (macro #10, posição 2/11)
export {
  vitrinePublicaSecaoSchema,
  vitrinePublicaTextoSchema,
  vitrinePublicaPlanoSchema,
  vitrinePublicaFaqSchema,
  vitrinePublicaMetricaSchema,
  vitrinePublicaSegmentoSchema,
  vitrinePublicaConteudoSchema,
} from "./vitrine-publica"
export type {
  VitrinePublicaSecao,
  VitrinePublicaTexto,
  VitrinePublicaPlano,
  VitrinePublicaFaq,
  VitrinePublicaMetrica,
  VitrinePublicaSegmento,
  VitrinePublicaConteudo,
} from "./vitrine-publica"

// Vitrine pública — contratos de pedido (macro #10, posição 3/11 — subtarefa 1)
export {
  vitrinePedidoCicloSchema,
  vitrinePedidoStatusSchema,
  vitrineDocumentoTipoConteudoSchema,
  vitrinePedidoDadosSchema,
  vitrinePedidoTextoLivreSchema,
  VITRINE_TEXTO_LIVRE_MAX_CHARS,
  VITRINE_TOKEN_ACOMPANHAMENTO_REGEX,
  vitrinePedidoCriacaoRespostaSchema,
  vitrinePedidoDocumentoSchema,
  vitrinePedidoAcompanhamentoSchema,
} from "./vitrine-pedidos"
export type {
  VitrinePedidoCiclo,
  VitrinePedidoStatus,
  VitrineDocumentoTipoConteudo,
  VitrinePedidoDados,
  VitrinePedidoCriacaoResposta,
  VitrinePedidoDocumento,
  VitrinePedidoAcompanhamento,
} from "./vitrine-pedidos"

// Configuração validada do transbordo para atendimento humano.
export {
  transbordoDestinoTipoSchema,
  transbordoHorarioSchema,
  transbordoDestinoSchema,
  transbordoConfigSchema,
} from "./transbordo"
export type {
  TransbordoDestinoTipo,
  TransbordoHorario,
  TransbordoDestino,
  TransbordoConfig,
} from "./transbordo"
export type {
  HelpDeskSession,
  HelpDeskMessage,
  HelpDeskSendMessageInput,
  HelpDeskHistory,
} from "./helpdesk"
export type {
  AgentInfo,
  ChatMessageRole,
  ChatAttachment,
  ChatMessage,
  ChatSession,
  StartChatSessionInput,
  SendChatMessageInput,
  ChatHistory,
  AgentChatDataSource,
  SendChatMessageSuccess,
  ChatSendFailureReason,
  SendChatMessageFailure,
  SendChatMessageResult,
} from "./chat"
