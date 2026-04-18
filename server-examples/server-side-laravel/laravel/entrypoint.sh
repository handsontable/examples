#!/bin/bash
set -e

echo "[entrypoint] Running database migrations..."
php artisan migrate --force

echo "[entrypoint] Seeding database (skipped if already seeded)..."
php artisan db:seed --class=ProductSeeder --force

echo "[entrypoint] Starting Apache..."
exec apache2-foreground
