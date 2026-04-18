CREATE TABLE IF NOT EXISTS products (
    id       BIGSERIAL    PRIMARY KEY,
    name     VARCHAR(255) NOT NULL,
    sku      VARCHAR(255) NOT NULL UNIQUE,
    category VARCHAR(255),
    price    DECIMAL(10, 2),
    stock    INTEGER
);
