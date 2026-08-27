/**
 * Bootstrap da API Biblioteca Global (PoC §6.1).
 * Prefixo /api, CORS, validação global e filtro padronizado de erros.
 */
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"
import { configureApp } from "./bootstrap"
import { EnvService } from "./config/env.service"
import { WsAdapter } from "@nestjs/platform-ws"

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.useWebSocketAdapter(new WsAdapter(app))
  configureApp(app)
  const env = app.get(EnvService)
  await app.listen(env.apiPort)
  console.log(`API Biblioteca Global em http://localhost:${env.apiPort}/api`)
}

void bootstrap()
