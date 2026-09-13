export type MotorConfiguracaoTipo = "number" | "string" | "boolean"

export type MotorConfiguracaoValor = number | string | boolean

export type MotorConfiguracaoResposta = {
  chave: string
  tipo: MotorConfiguracaoTipo
  valor: MotorConfiguracaoValor
  valorPadrao: MotorConfiguracaoValor
  regraValidacao: string
  descricao: string
  editavel: true
  atualizadoEm: Date | null
}

export type MotorConfiguracaoDefinicao = {
  chave: string
  tipo: MotorConfiguracaoTipo
  valorPadrao: MotorConfiguracaoValor
  regraValidacao: string
  descricao: string
  validar: (valor: unknown) => boolean
}

const inteiroPositivo = (valor: unknown, max: number): valor is number =>
  typeof valor === "number" && Number.isInteger(valor) && valor >= 1 && valor <= max

export const MOTOR_CONFIGURACOES: readonly MotorConfiguracaoDefinicao[] = [
  { chave: "motor.max_workers", tipo: "number", valorPadrao: 1, regraValidacao: "inteiro entre 1 e 100", descricao: "Número máximo global de tarefas de desenvolvimento em paralelo.", validar: (v) => inteiroPositivo(v, 100) },
  { chave: "motor.max_workers_per_project", tipo: "number", valorPadrao: 1, regraValidacao: "inteiro entre 1 e 100", descricao: "Número máximo de tarefas em paralelo por projeto.", validar: (v) => inteiroPositivo(v, 100) },
  { chave: "motor.max_delivery_attempts", tipo: "number", valorPadrao: 20, regraValidacao: "inteiro entre 1 e 200", descricao: "Número máximo de entregas por subtarefa antes de bloqueá-la por excesso de tentativas.", validar: (v) => inteiroPositivo(v, 200) },
  { chave: "motor.pump_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Intervalo de consulta da fila de tarefas.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.reconciler_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Intervalo de reconciliação de leases e execuções órfãs.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.worker_timeout_ms", tipo: "number", valorPadrao: 14400000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Tempo máximo de execução de um worker.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.worker_silence_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Tempo sem heartbeat antes de considerar o worker travado.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.resource_lease_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Duração do lease de um recurso exclusivo.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.resource_heartbeat_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 86400000", descricao: "Intervalo de renovação dos leases de recursos.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 1000 },
  { chave: "motor.console_run_absolute_timeout_ms", tipo: "number", valorPadrao: 14400000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Tempo máximo absoluto de uma execução remota no Console.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.console_run_idle_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Tempo sem progresso permitido em uma execução remota.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.console_poll_interval_ms", tipo: "number", valorPadrao: 5000, regraValidacao: "inteiro entre 1000 e 600000", descricao: "Intervalo de consulta do estado de uma execução remota.", validar: (v) => inteiroPositivo(v, 600000) && v >= 1000 },
  { chave: "motor.console_send_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para enviar uma mensagem ao Console.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
  { chave: "motor.dependency_install_timeout_ms", tipo: "number", valorPadrao: 900000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para instalar dependências.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
  { chave: "motor.worker_shutdown_timeout_ms", tipo: "number", valorPadrao: 10000, regraValidacao: "inteiro entre 1000 e 120000", descricao: "Tempo de encerramento gracioso de workers.", validar: (v) => inteiroPositivo(v, 120000) && v >= 1000 },
  { chave: "motor.resource_event_wait_timeout_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Tempo máximo de espera por evento de recurso.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.baseline_confirmation_timeout_ms", tipo: "number", valorPadrao: 300000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para confirmar o baseline.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
  { chave: "motor.build_test_timeout_ms", tipo: "number", valorPadrao: 300000, regraValidacao: "inteiro entre 60000 e 3600000", descricao: "Tempo máximo para execução de build e testes unitários.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 60000 },
  { chave: "motor.prompt_description_embed_max_chars", tipo: "number", valorPadrao: 12000, regraValidacao: "inteiro entre 1000 e 100000", descricao: "Tamanho máximo da descrição embutida no prompt; acima disso ela é enviada em mensagem separada.", validar: (v) => inteiroPositivo(v, 100000) && v >= 1000 },
  { chave: "motor.prompt_description_context_max_chars", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 100000", descricao: "Tamanho máximo da descrição enviada na mensagem de contexto separada.", validar: (v) => inteiroPositivo(v, 100000) && v >= 1000 },
  { chave: "motor.orphan_analysis_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 60000 e 3600000", descricao: "Tempo sem atividade antes de recuperar tarefa orfa em analise.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 60000 },
  { chave: "motor.console_url", tipo: "string", valorPadrao: "http://127.0.0.1:6280", regraValidacao: "URL valida", descricao: "URL do Console OpenClaw para consultas de sessao.", validar: (v) => typeof v === "string" && v.startsWith("http") },
  { chave: "motor.console_token", tipo: "string", valorPadrao: "", regraValidacao: "string", descricao: "Token de autenticacao do Console OpenClaw.", validar: (v) => typeof v === "string" },
  { chave: "motor.session_history_page_size", tipo: "number", valorPadrao: 50, regraValidacao: "inteiro entre 1 e 500", descricao: "Numero de linhas do historico de sessao carregadas por pagina.", validar: (v) => inteiroPositivo(v, 500) },
  { chave: "motor.model_cooldown_auth_ms", tipo: "number", valorPadrao: 3600000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Cooldown global de um modelo apos falha de autenticacao/token (sem chave, chave invalida, 401/403).", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.model_cooldown_quota_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Cooldown global de um modelo apos cota esgotada ou rate limit (429, quota, billing, credits).", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.model_cooldown_not_found_ms", tipo: "number", valorPadrao: 21600000, regraValidacao: "inteiro entre 60000 e 604800000", descricao: "Cooldown global de um modelo removido ou inexistente (404, model not found/not allowed).", validar: (v) => inteiroPositivo(v, 604800000) && v >= 60000 },
  { chave: "motor.model_cooldown_session_ms", tipo: "number", valorPadrao: 900000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Cooldown global de um modelo cuja sessao nao entrega (falhas identicas sem assinatura de provedor).", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.model_cooldown_growth_factor", tipo: "number", valorPadrao: 1.5, regraValidacao: "numero entre 1 e 10", descricao: "Fator de crescimento do cooldown a cada reincidencia do mesmo modelo (1.5 = +50%).", validar: (v) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 10 },
  { chave: "motor.model_cooldown_max_ms", tipo: "number", valorPadrao: 43200000, regraValidacao: "inteiro entre 60000 e 604800000", descricao: "Teto do cooldown de um modelo (nao cresce alem disso).", validar: (v) => inteiroPositivo(v, 604800000) && v >= 60000 },
]

export function configuracaoPorChave(chave: string): MotorConfiguracaoDefinicao | undefined {
  return MOTOR_CONFIGURACOES.find((configuracao) => configuracao.chave === chave)
}
