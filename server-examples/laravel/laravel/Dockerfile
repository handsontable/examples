FROM php:8.2-apache

# System deps for Laravel
RUN apt-get update && apt-get install -y \
    git curl zip unzip libpng-dev libonig-dev libxml2-dev default-mysql-client \
    && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Enable mod_rewrite for Laravel's front controller
RUN a2enmod rewrite

WORKDIR /var/www/html

# Create a fresh Laravel 11 project (includes key generation)
RUN composer create-project laravel/laravel . --prefer-dist --no-interaction 2>&1

# Apache vhost pointing at Laravel's public/ directory
COPY apache.conf /etc/apache2/sites-available/000-default.conf

# Bootstrap: add api route registration (Laravel 11 doesn't ship api.php by default)
COPY bootstrap/app.php bootstrap/app.php

# Application code (overlaid on top of the fresh install)
COPY app/Http/Controllers/ProductController.php app/Http/Controllers/ProductController.php
COPY app/Models/Product.php app/Models/Product.php

# Database migrations and seeders
COPY database/migrations/2024_01_01_000001_create_products_table.php database/migrations/2024_01_01_000001_create_products_table.php
COPY database/seeders/ProductSeeder.php database/seeders/ProductSeeder.php

# API routes
COPY routes/api.php routes/api.php

# Writable directories for www-data
RUN chown -R www-data:www-data storage bootstrap/cache

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
