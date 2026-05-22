FROM php:8.2-apache

# System deps for Symfony
RUN apt-get update && apt-get install -y \
    git curl zip unzip libpng-dev libonig-dev libxml2-dev \
    && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Enable mod_rewrite (needed by Symfony's FallbackResource)
RUN a2enmod rewrite

WORKDIR /var/www/html

# Install PHP dependencies first (separate layer — rebuilt only when composer.json changes)
COPY composer.json composer.lock ./
RUN mkdir -p var public \
    && composer install --no-dev --no-interaction --no-scripts --no-security-blocking --optimize-autoloader

# Apache vhost with FallbackResource (no .htaccess needed)
COPY apache.conf /etc/apache2/sites-available/000-default.conf

# Symfony skeleton files (front controller, CLI entry point)
COPY .env .env
COPY bin/console bin/console
COPY public/index.php public/index.php

# Application code, configuration, migrations
COPY src/ src/
COPY config/ config/
COPY migrations/ migrations/

RUN chmod +x bin/console \
    && mkdir -p var/cache var/log \
    && chown -R www-data:www-data var

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
