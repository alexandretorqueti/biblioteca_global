import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { TransbordoController, TransbordoMagicLinkController } from "./transbordo.controller"
import { TransbordoService } from "./transbordo.service"
import { SmtpTransbordoAdapter, TelegramTransbordoAdapter, TransbordoNotifier, WhatsAppTransbordoAdapter } from "./transbordo.notifier"

@Module({
  imports: [AuthModule],
  controllers: [TransbordoController, TransbordoMagicLinkController],
  providers: [TransbordoService, TransbordoNotifier, SmtpTransbordoAdapter, TelegramTransbordoAdapter, WhatsAppTransbordoAdapter],
  exports: [TransbordoService, TransbordoNotifier],
})
export class TransbordoModule {}
