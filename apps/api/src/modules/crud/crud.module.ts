import { Global, Module } from "@nestjs/common"
import { EnvService } from "../../config/env.service"
import { AuthModule } from "../auth/auth.module"
import { RealtimeModule } from "../realtime/realtime.module"
import { CrudController } from "./crud.controller"
import { CrudService } from "./crud.service"
import {
  CONECTOR_PROJETO,
  criarConectorPadrao,
  PROJECT_DB_FACTORY,
  ProjectDbFactory,
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
      inject: [EnvService],
      useFactory: criarConectorPadrao,
    },
    { provide: PROJECT_DB_FACTORY, useClass: ProjectDbFactory },
  ],
  exports: [CrudService, PROJECT_DB_FACTORY, SCHEMA_REGISTRY, GestaoGlobalTasksRepository],
})
export class CrudModule {}
