/**
 * Configuração comum da aplicação Nest (usada pelo main.ts e pelos testes
 * funcionais, para que ambos exercitem exatamente o mesmo pipeline).
 */
import { ValidationPipe, type INestApplication } from "@nestjs/common"

export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix("api")
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
