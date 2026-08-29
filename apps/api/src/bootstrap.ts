/**
 * Configuração comum da aplicação Nest (usada pelo main.ts e pelos testes
 * funcionais, para que ambos exercitem exatamente o mesmo pipeline).
 */
import { ValidationPipe, type INestApplication } from "@nestjs/common"
import { WsAdapter } from "@nestjs/platform-ws"

export function configureApp(app: INestApplication): INestApplication {
  // O realtime da Biblioteca usa WebSocket padrão (ws), não Socket.IO.
  // Este bootstrap também é usado pelos testes funcionais; configurar o
  // adapter aqui evita que o Nest tente carregar Socket.IO implicitamente.
  app.useWebSocketAdapter(new WsAdapter(app))
  app.setGlobalPrefix("api")
  // O front de produção é servido no mesmo host; manter o CORS padrão
  // preserva os consumidores cross-origin existentes. O WebSocket usa
  // cookie automaticamente em conexões same-origin.
  app.enableCors()
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  return app
}
