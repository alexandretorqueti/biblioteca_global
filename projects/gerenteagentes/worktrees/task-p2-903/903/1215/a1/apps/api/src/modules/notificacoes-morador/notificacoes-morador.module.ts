/**
 * NotificacoesMoradorModule — endpoints para o morador visualizar e gerenciar
 * suas notificações (sininho).
 *
 * Importa AuthModule (para guards) e registra controller + service.
 * O ProjectDbFactory é global (exportado pelo CrudModule), então o service
 * pode injetá-lo diretamente.
 */
import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { NotificacoesMoradorController } from "./notificacoes-morador.controller"
import { NotificacoesMoradorService } from "./notificacoes-morador.service"

@Module({
  imports: [AuthModule],
  controllers: [NotificacoesMoradorController],
  providers: [NotificacoesMoradorService],
  exports: [NotificacoesMoradorService],
})
export class NotificacoesMoradorModule {}
