/**
 * GestaoTarefasGlobalAnexosModule — anexos de tarefas (gestao-de-tarefas-global
 * — macro #6, subtarefa 1).
 *
 * Registro: importado em apps/api/src/app.module.ts ANTES do CrudModule —
 * as rotas `:slug/tarefas/:id/anexos[...]` são mais específicas que
 * `:slug/:resource` do CRUD e precisam ser casadas primeiro (mesma
 * precedência do módulo fluxo).
 *
 * Dependências:
 * - AuthModule: JwtService (JwtModule exportado) para o JwtAuthGuard;
 * - CrudModule (@Global): PROJECT_DB_FACTORY (banco do projeto) +
 *   EscopoOrganizacaoGuard/REPOSITORIO_TENANCY (tenancy intra-projeto) —
 *   reutilizados pelo EscopoFluxoPorSlugGuard, exportado pelo módulo fluxo
 *   (nenhuma dependência nova);
 * - EnvService (APP_PROVIDE global): ANEXOS_DIR / ANEXOS_MAX_BYTES.
 *
 * Segurança: escopo row-level (404 para tarefa/anexo de outra organização);
 * append-only — nenhuma rota PUT/PATCH/DELETE.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { CrudModule } from "../crud/crud.module"
import { AnexosController } from "./anexos.controller"
import { GestaoTarefasGlobalAnexosService } from "./anexos.service"

@Module({
  imports: [AuthModule, CrudModule],
  controllers: [AnexosController],
  providers: [GestaoTarefasGlobalAnexosService],
  exports: [GestaoTarefasGlobalAnexosService],
})
export class GestaoTarefasGlobalAnexosModule {}
