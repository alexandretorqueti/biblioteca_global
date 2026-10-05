import { Module, OnModuleInit } from '@nestjs/common';
import { GerenteAgentesController } from './gerenteagentes.controller';
import { GerenteAgentesService } from './gerenteagentes.service';
import { TaskStatusPollerService } from './task-status-poller.service';
import { GitInspectorService } from './git-inspector.service';
import { AuthModule } from '../../../apps/api/src/modules/auth/auth.module';
import { ProvisionModule } from '../../../apps/api/src/modules/provision/provision.module';
import { IsaChatController, IsaChatService, IsaChatBridgeService } from './isa-chat';
import { RealtimeModule } from '../../../apps/api/src/modules/realtime/realtime.module';
import { RealtimeGateway } from '../../../apps/api/src/modules/realtime/realtime.gateway';
import { OperationalFeedService } from './operational-feed';

@Module({
  imports: [AuthModule, ProvisionModule, RealtimeModule],
  controllers: [GerenteAgentesController, IsaChatController],
  providers: [
    GerenteAgentesService,
    TaskStatusPollerService,
    GitInspectorService,
    IsaChatService,
    IsaChatBridgeService,
    OperationalFeedService,
  ],
  exports: [
    GerenteAgentesService,
    TaskStatusPollerService,
    GitInspectorService,
    IsaChatService,
    IsaChatBridgeService,
    OperationalFeedService,
  ],
})
export class GerenteAgentesModule implements OnModuleInit {
  constructor(
    private readonly poller: TaskStatusPollerService,
    private readonly service: GerenteAgentesService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  onModuleInit() {
    // Inicia polling do motor DEV como fallback de reconciliação (30s)
    // O caminho principal de atualização agora é o WebSocket via eventos
    this.poller.startPolling(30000);
    // Registra o provider de snapshot do mapa para o canal WebSocket 'map'
    this.realtimeGateway.setMapSnapshotProvider((projectId) =>
      this.service.construirSnapshotMapa(projectId)
    );
  }
}
