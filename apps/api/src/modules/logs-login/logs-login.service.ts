import { BadRequestException, Inject, Injectable } from "@nestjs/common"
import type { PaginatedResult } from "@biblioteca-global/shared"
import {
  LOGS_LOGIN_REPOSITORY,
  type LogLoginListItem,
  type LogsLoginRepository,
} from "./logs-login.repository"
import type { ListLogsLoginQueryDto } from "./dto/list-logs-login-query.dto"

@Injectable()
export class LogsLoginService {
  constructor(
    @Inject(LOGS_LOGIN_REPOSITORY)
    private readonly repo: LogsLoginRepository,
  ) {}

  async listar(
    query: ListLogsLoginQueryDto,
  ): Promise<PaginatedResult<LogLoginListItem>> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20
    if (page < 1 || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException("Paginação inválida")
    }
    const resultado = await this.repo.listar({
      page,
      pageSize,
      search: query.search,
    })
    return { ...resultado, page, pageSize }
  }
}
