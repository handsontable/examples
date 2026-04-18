import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketEntity } from './ticket.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'tickets',
      password: process.env.DB_PASS || 'tickets',
      database: process.env.DB_NAME || 'tickets',
      entities: [TicketEntity],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([TicketEntity]),
  ],
  controllers: [TicketsController],
  providers: [TicketsService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
    }),
  );

  await app.listen(3000);
  console.log('NestJS server running on http://localhost:3000');
}

bootstrap();
