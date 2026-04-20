import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FetchTicketsDto } from './fetch-tickets.dto';
import { TicketEntity, TicketPriority, TicketStatus } from './ticket.entity';

export interface CreateTicketDto {
  subject: string;
  status: string;
  priority: string;
  assignee: string;
  createdAt: string;
}

export interface UpdateTicketDto extends Partial<CreateTicketDto> {
  id: string;
}

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(TicketEntity)
    private readonly repo: Repository<TicketEntity>,
  ) {}

  async findAll(dto: FetchTicketsDto): Promise<{ rows: TicketEntity[]; totalRows: number }> {
    const qb = this.repo.createQueryBuilder('ticket');

    if (dto.filters && dto.filters.length > 0) {
      for (const [i, filter] of dto.filters.entries()) {
        const param = `val${i}`;
        const col = `ticket.${filter.prop}`;

        const val = filter.value[0];
        // Escape LIKE metacharacters so user input is treated literally.
        const esc = (s: string) => s.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
        const like = `LIKE LOWER(:${param}) ESCAPE '!'`;
        const notLike = `NOT LIKE LOWER(:${param}) ESCAPE '!'`;

        switch (filter.condition) {
          case 'eq':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) = LOWER(:${param})`, { [param]: val });
            break;
          case 'neq':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) != LOWER(:${param})`, { [param]: val });
            break;
          case 'contains':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) ${like}`, { [param]: `%${esc(val)}%` });
            break;
          case 'not_contains':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) ${notLike}`, { [param]: `%${esc(val)}%` });
            break;
          case 'begins_with':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) ${like}`, { [param]: `${esc(val)}%` });
            break;
          case 'ends_with':
            if (val !== undefined) qb.andWhere(`LOWER(${col}::text) ${like}`, { [param]: `%${esc(val)}` });
            break;
          case 'empty':
            qb.andWhere(`(${col} IS NULL OR ${col}::text = '')`);
            break;
          case 'not_empty':
            qb.andWhere(`(${col} IS NOT NULL AND ${col}::text != '')`);
            break;
        }
      }
    }

    if (dto.sort) {
      qb.orderBy(`ticket.${dto.sort.column}`, dto.sort.order.toUpperCase() as 'ASC' | 'DESC');
    } else {
      qb.orderBy('ticket.createdAt', 'ASC');
    }

    const [rows, totalRows] = await qb
      .skip((dto.page - 1) * dto.pageSize)
      .take(dto.pageSize)
      .getManyAndCount();

    return { rows, totalRows };
  }

  async create(dto: CreateTicketDto): Promise<TicketEntity> {
    const ticket = this.repo.create({
      subject: dto.subject,
      status: dto.status as TicketStatus,
      priority: dto.priority as TicketPriority,
      assignee: dto.assignee,
      createdAt: dto.createdAt ?? new Date().toISOString().slice(0, 10),
    });
    return this.repo.save(ticket);
  }

  async updateMany(updates: UpdateTicketDto[]): Promise<TicketEntity[]> {
    const updated: TicketEntity[] = [];
    for (const { id, ...rest } of updates) {
      await this.repo.update(id, rest as Partial<TicketEntity>);
      const ticket = await this.repo.findOneBy({ id });
      if (ticket) updated.push(ticket);
    }
    return updated;
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.repo.delete(ids);
    }
  }
}
