import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, isISO8601, Matches, MaxLength, ValidateIf } from 'class-validator';
import { Repository } from 'typeorm';
import { FetchTicketsDto } from './fetch-tickets.dto';
import { TICKET_PRIORITIES, TICKET_STATUSES, TicketEntity, TicketPriority, TicketStatus } from './ticket.entity';

// Request bodies for POST and PATCH. MaxLength values match the VARCHAR
// columns in the migration; createdAt is a 'YYYY-MM-DD' string. @Matches
// checks the shape and @IsISO8601 rejects impossible dates such as 2025-02-30.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Like @IsOptional(), but rejects null: every column is NOT NULL.
const IfPresent = () => ValidateIf((_object, value) => value !== undefined);

// Clearing a text cell sends null. Store it as an empty string.
const NullToEmpty = () => Transform(({ value }) => (value === null ? '' : value));

// Date filter values come from the grid's date inputs as 'YYYY-MM-DD'. A full
// ISO 8601 date-time is cut to its date part, anything else returns 400. An
// empty input becomes null, which matches no row, as in the grid's own filter.
function toIsoDate(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!isISO8601(value, { strict: true }) || !ISO_DATE.test(value.slice(0, 10))) {
    throw new BadRequestException(`Invalid date filter value: ${value}`);
  }
  return value.slice(0, 10);
}

// date_today, date_tomorrow and date_yesterday send no value, so "today" is
// the server's local date. The grid's own filter uses the browser's time zone.
function localIsoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class CreateTicketDto {
  @NullToEmpty()
  @IsString()
  @MaxLength(500)
  subject: string;

  @IsIn(TICKET_STATUSES)
  status: TicketStatus;

  @IsIn(TICKET_PRIORITIES)
  priority: TicketPriority;

  @NullToEmpty()
  @IsString()
  @MaxLength(200)
  assignee: string;

  @IsOptional()
  @Matches(ISO_DATE)
  @IsISO8601({ strict: true })
  createdAt?: string;
}

export class UpdateTicketDto {
  @IsUUID()
  id: string;

  @NullToEmpty()
  @IfPresent()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @IfPresent()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @IfPresent()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @NullToEmpty()
  @IfPresent()
  @IsString()
  @MaxLength(200)
  assignee?: string;

  @IfPresent()
  @Matches(ISO_DATE)
  @IsISO8601({ strict: true })
  createdAt?: string;
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
        // CAST(... AS text), not ::text: TypeORM maps ticket.createdAt to the
        // created_at column only when a space, "=", ")", or "," follows the name.
        const text = `CAST(${col} AS text)`;

        const val = filter.value[0];
        // Escape LIKE metacharacters so user input is treated literally.
        const esc = (s: string) => s.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
        const like = `LIKE LOWER(:${param}) ESCAPE '!'`;
        const notLike = `NOT LIKE LOWER(:${param}) ESCAPE '!'`;

        switch (filter.condition) {
          case 'eq':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) = LOWER(:${param})`, { [param]: val });
            break;
          case 'neq':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) != LOWER(:${param})`, { [param]: val });
            break;
          case 'contains':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) ${like}`, { [param]: `%${esc(val)}%` });
            break;
          case 'not_contains':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) ${notLike}`, { [param]: `%${esc(val)}%` });
            break;
          case 'begins_with':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) ${like}`, { [param]: `${esc(val)}%` });
            break;
          case 'ends_with':
            if (val !== undefined) qb.andWhere(`LOWER(${text}) ${like}`, { [param]: `%${esc(val)}` });
            break;
          case 'empty':
            qb.andWhere(`(${col} IS NULL OR ${text} = '')`);
            break;
          case 'not_empty':
            qb.andWhere(`(${col} IS NOT NULL AND ${text} != '')`);
            break;
          // created_at holds 'YYYY-MM-DD' text, so string order is date order.
          case 'date_before':
            qb.andWhere(`${col} < :${param}`, { [param]: toIsoDate(val) });
            break;
          case 'date_before_or_equal':
            qb.andWhere(`${col} <= :${param}`, { [param]: toIsoDate(val) });
            break;
          case 'date_after':
            qb.andWhere(`${col} > :${param}`, { [param]: toIsoDate(val) });
            break;
          case 'date_after_or_equal':
            qb.andWhere(`${col} >= :${param}`, { [param]: toIsoDate(val) });
            break;
          case 'between':
            // Inclusive on both ends. The grid offers it only for createdAt.
            qb.andWhere(`${col} >= :${param}from AND ${col} <= :${param}to`, {
              [`${param}from`]: toIsoDate(val),
              [`${param}to`]: toIsoDate(filter.value[1]),
            });
            break;
          case 'date_today':
            qb.andWhere(`${col} = :${param}`, { [param]: localIsoDate(0) });
            break;
          case 'date_tomorrow':
            qb.andWhere(`${col} = :${param}`, { [param]: localIsoDate(1) });
            break;
          case 'date_yesterday':
            qb.andWhere(`${col} = :${param}`, { [param]: localIsoDate(-1) });
            break;
          default:
            // Unreachable: FilterConditionDto accepts only the names handled above.
            throw new BadRequestException(`Unsupported condition: ${filter.condition satisfies never}`);
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
      status: dto.status,
      priority: dto.priority,
      assignee: dto.assignee,
      createdAt: dto.createdAt ?? new Date().toISOString().slice(0, 10),
    });
    return this.repo.save(ticket);
  }

  async updateMany(updates: UpdateTicketDto[]): Promise<TicketEntity[]> {
    const updated: TicketEntity[] = [];
    for (const { id, ...rest } of updates) {
      // Skip rows with no columns left after validation stripped unknown keys.
      if (Object.keys(rest).length > 0) await this.repo.update(id, rest);
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
