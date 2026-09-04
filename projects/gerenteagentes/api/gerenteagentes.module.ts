import { Module, OnModuleInit } from '@nestjs/common';
import { GerenteAgentesController } from './gerenteagentes.controller';
import { GerenteAgentesService } from './gerenteagentes.service';
import { TaskStatusPollerService } from './task-status-poller.service';
import { AuthModule } from '../../../apps/api/src/modules/auth/auth.module';
import { ProvisionModule } from '../../../apps/api/src/modules/provision/provision.module';
import { IsaChatController, IsaChatService, IsaChatBridgeService } from './isa-chat';
import { RealtimeModule } from '../../../apps/api/src/modules/realtime/realtime.module';

@Module({
  imports: [AuthModule, ProvisionModule, RealtimeModule],
  controllers: [GerenteAgentesController, IsaChatController],
  providers: [
    GerenteAgentesService,
    TaskStatusPollerService,
    IsaChatService,
    IsaChatBridgeService,
  ],
  exports: [
    GerenteAgentesService,
    TaskStatusPollerService,
    IsaChatService,
    IsaChatBridgeService,
  ],
})
export class GerenteAgentesModule implements OnModuleInit {
  constructor(private readonly poller: TaskStatusPollerService) {}

  onModuleInit() {
    // Inicia polling do motor DEV (5s)
    this.poller.startPolling(5000);
  }
}
