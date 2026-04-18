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

        switch (filter.condition) {
          case 'eq':
            qb.andWhere(`LOWER(${col}::text) = LOWER(:${param})`, { [param]: filter.value[0] });
            break;
          case 'neq':
            qb.andWhere(`LOWER(${col}::text) != LOWER(:${param})`, { [param]: filter.value[0] });
            break;
          case 'contains':
            qb.andWhere(`LOWER(${col}::text) LIKE LOWER(:${param})`, { [param]: `%${filter.value[0]}%` });
            break;
          case 'not_contains':
            qb.andWhere(`LOWER(${col}::text) NOT LIKE LOWER(:${param})`, { [param]: `%${filter.value[0]}%` });
            break;
          case 'begins_with':
            qb.andWhere(`LOWER(${col}::text) LIKE LOWER(:${param})`, { [param]: `${filter.value[0]}%` });
            break;
          case 'ends_with':
            qb.andWhere(`LOWER(${col}::text) LIKE LOWER(:${param})`, { [param]: `%${filter.value[0]}` });
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
