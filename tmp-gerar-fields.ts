/**
 * TEMPORÁRIO (subtarefa 3) — deriva os fields do schema.ts via gerarFields
 * e converte field.name para o nome de PROPRIEDADE TS (camelCase), que é o
 * contrato das linhas retornadas pelo CRUD (drizzle) e aceito no body via
 * normalizarChaves. Saída usada para materializar projects/.../config.ts.
 */
import { getTableColumns } from "drizzle-orm"
import * as schemaMod from "./projects/gestao-de-tarefas-global/schema"
import {
  coletarAnnotations,
  coletarTabelas,
  gerarFields,
} from "./packages/schema-tools/src/index"

const tabelas = coletarTabelas(schemaMod as Record<string, unknown>)
const annotations = coletarAnnotations(schemaMod as Record<string, unknown>)

for (const [nome, tabela] of Object.entries(tabelas)) {
  const colunas = getTableColumns(tabela)
  const porColuna = new Map<string, string>()
  for (const [prop, col] of Object.entries(colunas)) porColuna.set(col.name, prop)
  const fields = gerarFields(tabela, nome, (annotations[nome] ?? {}) as never, tabelas)
  const camel = fields.map((f) => ({ ...f, name: porColuna.get(f.name) ?? f.name }))
  console.log(`=== ${nome} ===`)
  console.log(JSON.stringify(camel, null, 1))
}
