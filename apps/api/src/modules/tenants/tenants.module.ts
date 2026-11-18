import { Module } from "@nestjs/common"
import { TenantsController } from "./tenants.controller"
import {
  DrizzleTenantsRepository,
  TENANTS_REPOSITORY,
} from "./tenants.repository"
import { TenantsService } from "./tenants.service"

@Module({
  controllers: [TenantsController],
  providers: [
    TenantsService,
    { provide: TENANTS_REPOSITORY, useClass: DrizzleTenantsRepository },
  ],
  exports: [TenantsService, TENANTS_REPOSITORY],
})
export class TenantsModule {}
