export type SetupChecklist = {
  structure: boolean
  configSchemaMigrations: boolean
  registries: boolean
  repoPath: boolean
  agentLink?: boolean
}

export type SmokeTestEvidence = {
  url: string
  method: string
  status: number
  response_body?: string
  timestamp: string
}

export type SetupEvidence = {
  checklist: SetupChecklist
  smoke_test?: SmokeTestEvidence
  [key: string]: unknown
}

export type SetupGateResult =
  | { ok: true; evidence: SetupEvidence }
  | { ok: false; reasons: string[] }

/**
 * Validação determinística do resultado do setup. O prompt é apenas uma
 * orientação: o projeto só pode virar `verified` quando esta função aceitar
 * todos os itens aplicáveis e uma evidência JSON de HTTP 2xx.
 */
export function validateProjectSetupEvidence(input: unknown): SetupGateResult {
  if (!input || typeof input !== 'object') return { ok: false, reasons: ['evidência de setup ausente'] }
  const evidence = input as Partial<SetupEvidence>
  const checklist = evidence.checklist
  const reasons: string[] = []
  if (!checklist || typeof checklist !== 'object') {
    reasons.push('checklist ausente')
  } else {
    for (const item of ['structure', 'configSchemaMigrations', 'registries', 'repoPath'] as const) {
      if (checklist[item] !== true) reasons.push(`checklist incompleto: ${item}`)
    }
    if ('agentLink' in checklist && checklist.agentLink !== true) reasons.push('checklist incompleto: agentLink')
  }
  const smoke = evidence.smoke_test
  if (!smoke || typeof smoke !== 'object') {
    reasons.push('evidência smoke_test ausente')
  } else {
    if (typeof smoke.url !== 'string' || !smoke.url) reasons.push('smoke_test.url inválida')
    if (typeof smoke.method !== 'string' || !smoke.method) reasons.push('smoke_test.method inválido')
    if (!Number.isInteger(smoke.status) || smoke.status < 200 || smoke.status >= 300) reasons.push('smoke_test.status não é 2xx')
    if (typeof smoke.timestamp !== 'string' || !smoke.timestamp || Number.isNaN(Date.parse(smoke.timestamp))) reasons.push('smoke_test.timestamp inválido')
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, evidence: evidence as SetupEvidence }
}
