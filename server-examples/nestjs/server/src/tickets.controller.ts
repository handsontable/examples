import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { FetchTicketsDto } from './fetch-tickets.dto';
import { CreateTicketDto, TicketsService, UpdateTicketDto } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  /**
   * GET /tickets?page=1&pageSize=5&sort[column]=status&sort[order]=asc
   *   &filters[0][prop]=status&filters[0][condition]=eq&filters[0][value][0]=open
   */
  @Get()
  async findAll(@Query() query: FetchTicketsDto) {
    return this.ticketsService.findAll(query);
  }

  /**
   * POST /tickets
   * Body: single CreateTicketDto or array of CreateTicketDto
   */
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateTicketDto | CreateTicketDto[]) {
    const rows = Array.isArray(body) ? body : [body];
    return Promise.all(rows.map((dto) => this.ticketsService.create(dto)));
  }

  /**
   * PATCH /tickets
   * Body: [{ id: 'uuid', status: 'resolved' }, ...]
   */
  @Patch()
  async updateMany(@Body() body: UpdateTicketDto[]) {
    return this.ticketsService.updateMany(body);
  }

  /**
   * DELETE /tickets
   * Body: ['uuid1', 'uuid2', ...]
   */
  @Delete()
  @HttpCode(204)
  async removeMany(@Body() ids: string[]) {
    await this.ticketsService.removeMany(ids);
  }
}
