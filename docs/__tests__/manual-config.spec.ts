// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const manual = readFileSync(resolve(process.cwd(), "docs/MANUAL_CONFIG_PROJETOS.md"), "utf8")

describe("manual operacional de configuração", () => {
  it("mantém seções contratuais", () => {
    for (const section of [
      "## 1. Config versionada versus corrente", "## 3. GeradorSistemaConfig, menus e telas",
      "### Tipos de tela", "### childRoutes", "## 4. schema.ts, annotations e CRUD derivado",
      "## 5. Migrations, registries e provisionamento", "## 6. API, auth e escopo por token",
      "## 7. Exemplo completo mínimo executável como referência", "## 8. Regras explícitas de reutilização",
      "## 9. Checklist de entrega",
    ]) expect(manual).toContain(section)
  })

  it("mantém caminhos reais e projetos de referência", () => {
    for (const path of [
      "packages/shared/src/config.ts", "packages/schema-tools/src/gerar-config.ts",
      "packages/schema-tools/src/gerar-fields.ts", "database/schema.ts",
      "apps/api/src/modules/crud/schema-registry.ts", "apps/api/src/modules/crud/project-db.factory.ts",
      "apps/api/src/modules/projetos/provisioner.service.ts", "apps/web/src/project/ProjectContext.tsx",
      "apps/web/src/project/registry/projects.ts", "apps/web/src/project/registry/customScreens.tsx",
      "projects/documentacao", "projects/gerenteagentes",
    ]) expect(manual).toContain(path)
  })

  it("mantém snippet de schema, config, migration, registries e child route", () => {
    for (const snippet of [
      'mysqlTable("clientes"', "satisfies FormAnnotationsPorTabela", "export const config: GeradorSistemaConfig",
      'kind: "cadastro"', 'resource: "clientes"', 'kind: "custom"', 'componentId: "clientes-manual"',
      "projects/clientes/migrations/", 'targetResource: "enderecos"', 'filterField: "clienteId"',
      "POST /api/provision/project", "npm run typecheck", "npm run lint", "npm test", "npm run build", "git diff --check",
    ]) expect(manual).toContain(snippet)
  })
})
