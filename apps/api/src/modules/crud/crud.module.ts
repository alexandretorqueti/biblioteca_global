import { Global, Module } from "@nestjs/common"
import { EnvService } from "../../config/env.service"
import { AuthModule } from "../auth/auth.module"
import { CrudController } from "./crud.controller"
import { CrudService } from "./crud.service"
import {
  CONECTOR_PROJETO,
  criarConectorPadrao,
  PROJECT_DB_FACTORY,
  ProjectDbFactory,
} from "./project-db.factory"
import { DynamicSchemaRegistry, SCHEMA_REGISTRY } from "./schema-registry"

@Global()
@Module({
  imports: [AuthModule],
  controllers: [CrudController],
  providers: [
    CrudService,
    { provide: SCHEMA_REGISTRY, useClass: DynamicSchemaRegistry },
    {
      provide: CONECTOR_PROJETO,
      inject: [EnvService],
      useFactory: criarConectorPadrao,
    },
    { provide: PROJECT_DB_FACTORY, useClass: ProjectDbFactory },
  ],
  exports: [CrudService, PROJECT_DB_FACTORY, SCHEMA_REGISTRY],
})
export class CrudModule {}
