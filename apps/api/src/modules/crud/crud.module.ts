import { Global, Module } from "@nestjs/common"
import { EnvService } from "../../config/env.service"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { AuthModule } from "../auth/auth.module"
import { RealtimeModule } from "../realtime/realtime.module"
import {
  EscopoOrganizacaoGuard,
  REPOSITORIO_TENANCY,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/escopo-organizacao.guard"
import { CrudController } from "./crud.controller"
import { CrudService } from "./crud.service"
import { CRUD_ESCOPO_EXTENSIONS } from "./escopo/escopo-crud.extension"
import { EscopoOrganizacaoPorSlugGuard } from "./escopo/escopo-organizacao-por-slug.guard"
import {
  GestaoTarefasGlobalEscopo,
  SLUG_GESTAO_TAREFAS_GLOBAL,
} from "./escopo/gestao-tarefas-global.escopo"
import { RepositorioTenancyProjectDb } from "./escopo/repositorio-tenancy.crud"
import {
  CONECTOR_PROJETO,
  criarConectorPadrao,
  PROJECT_DB_FACTORY,
  ProjectDbFactory,
  type ConectorProjeto,
} from "./project-db.factory"
import { DynamicSchemaRegistry, SCHEMA_REGISTRY } from "./schema-registry"
import { GestaoGlobalTasksRepository, GESTAO_GLOBAL_TASKS_REPOSITORY } from "./gestao-global-tasks.repository"

@Global()
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [CrudController],
  providers: [
    CrudService,
    GestaoGlobalTasksRepository,
    { provide: GESTAO_GLOBAL_TASKS_REPOSITORY, useExisting: GestaoGlobalTasksRepository },
    { provide: SCHEMA_REGISTRY, useClass: DynamicSchemaRegistry },
    {
      provide: CONECTOR_PROJETO,
      useFactory: criarConectorPadrao,
    },
    {
      provide: PROJECT_DB_FACTORY,
      inject: [CONECTOR_PROJETO, CORE_DB, EnvService],
      useFactory: (conector: ConectorProjeto, coreDb: CoreDb, env: EnvService) =>
        new ProjectDbFactory(conector, coreDb, env),
    },
    // Tenancy intra-projeto (gestao-de-tarefas-global): repositório do guard,
    // guard delegado + guard condicionado ao slug e extensão de escopo do CRUD.
    // Demais slugs não são afetados (guard transparente e extensão por slug).
    {
      provide: REPOSITORIO_TENANCY,
      inject: [PROJECT_DB_FACTORY, CORE_DB],
      useFactory: (factory: ProjectDbFactory, coreDb: CoreDb) =>
        new RepositorioTenancyProjectDb(factory, coreDb, SLUG_GESTAO_TAREFAS_GLOBAL),
    },
    EscopoOrganizacaoGuard,
    EscopoOrganizacaoPorSlugGuard,
    {
      provide: CRUD_ESCOPO_EXTENSIONS,
      useValue: [new GestaoTarefasGlobalEscopo()],
    },
  ],
  exports: [CrudService, PROJECT_DB_FACTORY, SCHEMA_REGISTRY, GestaoGlobalTasksRepository],
})
export class CrudModule {}
