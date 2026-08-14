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
import { UsuariosModule } from "./modules/usuarios/usuarios.module"

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", resolve(__dirname, "..", "..", "..", ".env")],
    }),
    // Limite global folgado; o login tem limite próprio mais rígido.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    EnvModule,
    DatabaseModule,
    AuthModule,
    UsuariosModule,
    ProjetosModule,
    // CrudModule por último: rotas :resource não podem sombrear as
    // específicas (auth/usuarios/projetos).
    CrudModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
