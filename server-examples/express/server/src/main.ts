import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import { AppDataSource } from './data-source';
import { ticketsRouter } from './tickets.router';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.use('/tickets', ticketsRouter);

AppDataSource.initialize()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Express server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error during Data Source initialization', err);
    process.exit(1);
  });
