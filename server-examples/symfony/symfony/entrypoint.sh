#!/bin/bash
set -e

echo "[entrypoint] Warming up Symfony cache..."
php bin/console cache:warmup

echo "[entrypoint] Running database migrations..."
php bin/console doctrine:migrations:migrate --no-interaction

echo "[entrypoint] Seeding database (skipped if already seeded)..."
php bin/console app:seed-products

echo "[entrypoint] Starting Apache..."
exec apache2-foreground
