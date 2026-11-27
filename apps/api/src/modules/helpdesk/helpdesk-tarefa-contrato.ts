/**
 * helpdesk-tarefa-contrato.ts — Contrato machine-readable de criação de tarefa
 * emitido pelo agente HelpDesk na resposta ao usuário.
 *
 * Formato EXATO (linha única, coberto por teste):
 *   criar_tarefa {"titulo":"...","descricao":"..."}
 *
 * A instrução ao agente (catálogo de prompts e fallback do bridge) deve usar
 * este mesmo texto canônico: `INSTRUCAO_CONTRATO_TAREFA_HELPDESK`. O formato
 * é espelhado e testado em ambos os lados (backend e prompt).
 *
 * O bloco é extraído no ponto único de persistência da resposta do agente
 * (persistirRespostaAgente), removido do texto visível e substituído pela
 * confirmação da tarefa draft criada. Sem bloco → nenhuma tarefa é criada.
 */

/** Token do contrato (palavra-chave que abre a linha de contrato). */
export const TOKEN_CONTRATO_TAREFA = "criar_tarefa"

/**
 * Texto canônico da instrução de emissão do bloco de contrato. Usado pelo
 * prompt persistido (AGENT_PROMPT_CATALOG) e pelo fallback do bridge, para
 * que a linha exata exigida pelo backend e a do prompt sejam a mesma string.
 */
export const INSTRUCAO_CONTRATO_TAREFA_HELPDESK =
  'Ao identificar uma solicitação de alteração, responda normalmente ao usuário e, no FINAL da resposta, inclua UMA única linha com o bloco de contrato no formato exato: criar_tarefa {"titulo":"<título objetivo da solicitação>","descricao":"<descrição completa da solicitação>"} — JSON válido em UMA linha única, sem aspas internas nem quebras de linha. O sistema remove essa linha do texto visível e cria a tarefa draft automaticamente.'

/** Limite da coluna `text` em helpdesk_mensagens (varchar 10000). */
export const LIMITE_TEXTO_MENSAGEM = 10_000

export interface ContratoTarefaHelpDesk {
  titulo: string
  descricao: string
}

interface ResultadoExtracao {
  textoVisivel: string
  contrato: ContratoTarefaHelpDesk | null
}

/**
 * Extrai o bloco de contrato de uma linha do texto da resposta do agente.
 *
 * Regras (cobertas por teste):
 * - só é reconhecido quando a linha começa EXATAMENTE com o token
 *   `criar_tarefa` seguido de espaço + objeto JSON;
 * - o JSON é validado: `titulo` e `descricao` devem ser strings não vazias;
 * - JSON inválido/ausente → `null` (a resposta é persistida inalterada);
 * - o bloco é removido do texto visível (linhas em branco remanescentes são
 *   normalizadas) e o texto final é truncado no limite da coluna.
 */
export function extrairContratoTarefa(texto: string): ResultadoExtracao {
  const limpo = (typeof texto === "string" ? texto : "").trim()
  if (!limpo) return { textoVisivel: "", contrato: null }

  const linhas = limpo.split("\n")
  let indiceBloco = -1
  let contrato: ContratoTarefaHelpDesk | null = null

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = (linhas[i] ?? "").trim()
    if (!linha.startsWith(`${TOKEN_CONTRATO_TAREFA} `)) continue

    const jsonBruto = linha.slice(TOKEN_CONTRATO_TAREFA.length).trim()
    try {
      const parsed: unknown = JSON.parse(jsonBruto)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).titulo === "string" &&
        ((parsed as Record<string, unknown>).titulo as string).trim().length > 0 &&
        typeof (parsed as Record<string, unknown>).descricao === "string" &&
        ((parsed as Record<string, unknown>).descricao as string).trim().length > 0
      ) {
        contrato = {
          titulo: ((parsed as Record<string, unknown>).titulo as string).trim(),
          descricao: ((parsed as Record<string, unknown>).descricao as string).trim(),
        }
        indiceBloco = i
        break
      }
    } catch {
      // Linha com o token mas JSON malformado → ignora (nenhuma tarefa).
      continue
    }
  }

  if (contrato === null || indiceBloco === -1) {
    const normalizado = limpo.replace(/\n{3,}/g, "\n\n").trim()
    return {
      textoVisivel: normalizado.length > LIMITE_TEXTO_MENSAGEM ? normalizado.slice(0, LIMITE_TEXTO_MENSAGEM) : normalizado,
      contrato: null,
    }
  }

  const visivel = [...linhas.slice(0, indiceBloco), ...linhas.slice(indiceBloco + 1)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return {
    textoVisivel: visivel.length > LIMITE_TEXTO_MENSAGEM ? visivel.slice(0, LIMITE_TEXTO_MENSAGEM) : visivel,
    contrato,
  }
}

/**
 * Confirmação exibida ao usuário quando a tarefa draft foi criada a partir do
 * bloco de contrato (mesma forma usada por `confirmarTarefa`).
 */
export function textoConfirmacaoTarefa(tarefa: { id: number; externalId: string; status: string }): string {
  return `Solicitação registrada como tarefa draft ${tarefa.externalId} (id ${tarefa.id}). Estado atual: ${tarefa.status}.`
}
