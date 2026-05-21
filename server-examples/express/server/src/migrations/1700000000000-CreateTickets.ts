import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTickets1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        subject     VARCHAR(500) NOT NULL,
        status      VARCHAR(20)  NOT NULL DEFAULT 'open',
        priority    VARCHAR(20)  NOT NULL DEFAULT 'medium',
        assignee    VARCHAR(200) NOT NULL,
        created_at  VARCHAR(10)  NOT NULL
      )
    `);

    await queryRunner.query(`
      INSERT INTO tickets (subject, status, priority, assignee, created_at) VALUES
        ('Login page throws 500 on Safari',             'open',        'high',     'Ana García',   '2025-01-15'),
        ('Export to CSV truncates long text fields',    'in-progress', 'medium',   'James Okafor', '2025-01-18'),
        ('Dark mode colors incorrect in Firefox',       'open',        'low',      'Li Wei',       '2025-01-22'),
        ('Grid row virtualization skips rows at scroll end', 'resolved', 'high',   'Ana García',   '2025-02-03'),
        ('Filter dropdown overlaps pagination controls','closed',      'low',      'James Okafor', '2025-02-10'),
        ('Column resize handle too narrow on touch screens','open',    'medium',   'Li Wei',       '2025-02-14'),
        ('Cell editor closes on any outside click',     'in-progress', 'critical', 'Ana García',   '2025-02-20'),
        ('Frozen columns desync on horizontal scroll',  'open',        'high',     'James Okafor', '2025-03-01'),
        ('Nested headers do not reorder with column move','resolved',  'medium',   'Li Wei',       '2025-03-05'),
        ('Sort indicator missing after page reload',    'open',        'low',      'Ana García',   '2025-03-12'),
        ('Numeric cell accepts non-numeric paste',      'in-progress', 'medium',   'James Okafor', '2025-03-18'),
        ('Context menu position off by 1px on HiDPI',  'closed',      'low',      'Li Wei',       '2025-03-25')
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tickets`);
  }
}
