import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { TicketEntity } from './ticket.entity';
import { CreateTickets1700000000000 } from './migrations/1700000000000-CreateTickets';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER || 'tickets',
  password: process.env.DB_PASS || 'tickets',
  database: process.env.DB_NAME || 'tickets',
  entities: [TicketEntity],
  migrations: [CreateTickets1700000000000],
  synchronize: false,
});
