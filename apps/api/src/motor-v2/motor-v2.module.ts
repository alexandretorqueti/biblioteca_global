/**
 * Módulo do motor-v2. Inicializa o motor dentro do container da API.
 */
import { Module } from '@nestjs/common'
import { MotorV2Service } from './motor-v2.service'

@Module({
  providers: [MotorV2Service],
})
export class MotorV2Module {}
