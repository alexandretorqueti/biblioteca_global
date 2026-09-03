import { Module } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { ConfigModule } from "@nestjs/config"
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler"
import { resolve } from "node:path"
import { ApiExceptionFilter } from "./common/filters/api-exception.filter"
import { EnvModule } from "./config/env.module"
import { DatabaseModule } from "./database/database.module"
import { AuthModule } from "./modules/auth/auth.module"
import { CrudModule } from "./modules/crud/crud.module"
import { ProjetosModule } from "./modules/projetos/projetos.module"
import { ProvisionModule } from "./modules/provision/provision.module"
import { UsuariosModule } from "./modules/usuarios/usuarios.module"
import { GerenteAgentesModule } from "../../../projects/gerenteagentes/api/gerenteagentes.module"
import { RealtimeModule } from "./modules/realtime/realtime.module"
import { EncomendasRegistroModule } from "./modules/encomendas-registro/encomendas-registro.module"

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", resolve(__dirname, "..", "..", "..", ".env")],
    }),
    // Limite global folgado; o login tem limite próprio mais rígido.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
    EnvModule,
    DatabaseModule,
    AuthModule,
    UsuariosModule,
    ProjetosModule,
    ProvisionModule,
    GerenteAgentesModule,
    RealtimeModule,
    EncomendasRegistroModule,
    // CrudModule por último: rotas :resource não podem sombrear as
    // específicas (auth/usuarios/projetos/gerenteagentes/encomendas-registro).
    CrudModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
