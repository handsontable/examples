import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  ParseArrayPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
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
   * Body: [{ subject, status, priority, assignee, createdAt }, ...]
   *
   * The global ValidationPipe skips array bodies, so ParseArrayPipe validates
   * each item against the DTO and strips undeclared keys.
   */
  @Post()
  @HttpCode(201)
  async create(@Body(new ParseArrayPipe({ items: CreateTicketDto, whitelist: true })) rows: CreateTicketDto[]) {
    return Promise.all(rows.map((dto) => this.ticketsService.create(dto)));
  }

  /**
   * PATCH /tickets
   * Body: [{ id: 'uuid', status: 'resolved' }, ...]
   */
  @Patch()
  async updateMany(@Body(new ParseArrayPipe({ items: UpdateTicketDto, whitelist: true })) rows: UpdateTicketDto[]) {
    return this.ticketsService.updateMany(rows);
  }

  /**
   * DELETE /tickets
   * Body: ['uuid1', 'uuid2', ...]
   */
  @Delete()
  @HttpCode(204)
  async removeMany(@Body(new ParseArrayPipe({ items: String })) ids: string[]) {
    if (!ids.every((id) => isUUID(id))) {
      throw new BadRequestException('Each id must be a UUID');
    }
    await this.ticketsService.removeMany(ids);
  }
}
