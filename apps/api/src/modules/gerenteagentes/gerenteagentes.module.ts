import { Module } from '@nestjs/common';
import { GerenteAgentesController } from './gerenteagentes.controller';
import { GerenteAgentesService } from './gerenteagentes.service';
import { CrudModule } from '../crud/crud.module';
import { AuthModule } from '../auth/auth.module';
import { ProvisionModule } from '../provision/provision.module';

@Module({
  imports: [CrudModule, AuthModule, ProvisionModule],
  controllers: [GerenteAgentesController],
  providers: [GerenteAgentesService],
  exports: [GerenteAgentesService],
})
export class GerenteAgentesModule {}
