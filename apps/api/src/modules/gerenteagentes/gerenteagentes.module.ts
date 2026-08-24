import { Module, OnModuleInit } from '@nestjs/common';
import { GerenteAgentesController } from './gerenteagentes.controller';
import { GerenteAgentesService } from './gerenteagentes.service';
import { TaskStatusPollerService } from './task-status-poller.service';
import { AuthModule } from '../auth/auth.module';
import { ProvisionModule } from '../provision/provision.module';

@Module({
  imports: [AuthModule, ProvisionModule],
  controllers: [GerenteAgentesController],
  providers: [GerenteAgentesService, TaskStatusPollerService],
  exports: [GerenteAgentesService, TaskStatusPollerService],
})
export class GerenteAgentesModule implements OnModuleInit {
  constructor(private readonly poller: TaskStatusPollerService) {}

  onModuleInit() {
    // Inicia polling do motor DEV (5s)
    this.poller.startPolling(5000);
  }
}
