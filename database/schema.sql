-- =============================================================================
--  CoCoffee F&B  -  MySQL 8.x / MariaDB 10.4+  -  schema
--  Import into database `cocoffee` (select it first in phpMyAdmin; shared
--  hosting users cannot CREATE DATABASE). Safe to re-run: drops & recreates.
-- =============================================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS media_files, customer_ledger, customers, app_settings, zalo_tokens, zalo_events, zalo_sessions, payments, inventory_movements,
                     order_items, orders, dining_tables, recipes, product_aliases, products,
                     inventory_items, categories, users;

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- Staff accounts (POS tablets + web admin)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  role          ENUM('admin','cashier') NOT NULL DEFAULT 'cashier',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Menu: categories -> products
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(30)  NOT NULL,             -- mixed_drink | cigarette | bottled_water | ...
  name       VARCHAR(100) NOT NULL,
  sort_order SMALLINT     NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Inventory: raw materials AND directly-sold goods (cigarettes, bottled water)
-- avg_cost = moving weighted-average unit cost (drives COGS)
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_items (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  sku              VARCHAR(40)   NOT NULL,
  name             VARCHAR(150)  NOT NULL,
  unit             VARCHAR(20)   NOT NULL,       -- g, ml, pack, bottle ...
  quantity_on_hand DECIMAL(14,3) NOT NULL DEFAULT 0,
  avg_cost         DECIMAL(14,4) NOT NULL DEFAULT 0,
  min_stock        DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  image_url        VARCHAR(255)  NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_sku (sku),
  KEY idx_inventory_low (is_active, quantity_on_hand, min_stock)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- stock_mode = 'bom'    -> deduct via `recipes` (mixed drinks)
-- stock_mode = 'direct' -> deduct 1:1 from inventory_item_id (cigarettes, bottled water)
CREATE TABLE products (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  category_id       INT UNSIGNED  NOT NULL,
  sku               VARCHAR(40)   NOT NULL,
  name              VARCHAR(150)  NOT NULL,
  price             DECIMAL(14,2) NOT NULL,
  stock_mode        ENUM('bom','direct') NOT NULL,
  inventory_item_id INT UNSIGNED  NULL,          -- required when stock_mode='direct' (enforced in code)
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  image_url         VARCHAR(255)  NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY idx_products_category (category_id, is_active),
  KEY idx_products_inventory (inventory_item_id),
  CONSTRAINT fk_products_category  FOREIGN KEY (category_id)       REFERENCES categories (id)      ON DELETE RESTRICT,
  CONSTRAINT fk_products_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Keywords the Zalo chatbot matches against (alias_norm = lowercase, no diacritics).
-- Globally unique so one phrase can never resolve to two products.
CREATE TABLE product_aliases (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT UNSIGNED NOT NULL,
  alias      VARCHAR(100) NOT NULL,
  alias_norm VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alias_norm (alias_norm),
  KEY idx_alias_product (product_id),
  CONSTRAINT fk_alias_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- BOM: quantity of inventory item consumed by ONE unit of the product
CREATE TABLE recipes (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  product_id        INT UNSIGNED  NOT NULL,
  inventory_item_id INT UNSIGNED  NOT NULL,
  quantity          DECIMAL(14,4) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recipe_line (product_id, inventory_item_id),
  KEY idx_recipe_inventory (inventory_item_id),
  CONSTRAINT fk_recipe_product   FOREIGN KEY (product_id)        REFERENCES products (id)        ON DELETE CASCADE,
  CONSTRAINT fk_recipe_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Tables (dining). current_order_id FK is added after `orders` exists.
-- -----------------------------------------------------------------------------
CREATE TABLE dining_tables (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code             VARCHAR(20)  NOT NULL,
  name             VARCHAR(60)  NOT NULL,
  capacity         SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  status           ENUM('available','serving') NOT NULL DEFAULT 'available',
  current_order_id INT UNSIGNED NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tables_code (code),
  UNIQUE KEY uq_tables_current_order (current_order_id),
  KEY idx_tables_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Orders
--   status         draft -> (Zalo, waiting for "ok")  | open -> (POS, being served)
--                  completed = finalized: stock deducted, COGS fixed, bill issued
--   payment_status tracked separately (Zalo orders complete as 'unpaid')
-- -----------------------------------------------------------------------------
CREATE TABLE orders (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_code       VARCHAR(30)   NULL,
  table_id         INT UNSIGNED  NULL,
  source           ENUM('pos','zalo') NOT NULL DEFAULT 'pos',
  zalo_user_id     VARCHAR(64)   NULL,
  zalo_chat_type   ENUM('user','group') NULL,
  zalo_chat_id     VARCHAR(64)   NULL,            -- user id (1:1) or group id (GMF)
  status           ENUM('draft','open','completed','cancelled') NOT NULL DEFAULT 'open',
  payment_status   ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid',
  payment_method   ENUM('cash','transfer','card','other') NULL,
  subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount         DECIMAL(14,2) NOT NULL DEFAULT 0,
  total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  cogs_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  note             VARCHAR(255)  NULL,
  customer_id      INT UNSIGNED  NULL,              -- customers.id (debtor / regular); no FK: customers is created later
  created_by       INT UNSIGNED  NULL,
  paid_at          DATETIME      NULL,
  completed_at     DATETIME      NULL,
  receipt_sent_at  DATETIME      NULL,
  receipt_error    VARCHAR(255)  NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_code (order_code),
  KEY idx_orders_status_created (status, created_at),
  KEY idx_orders_completed (completed_at),
  KEY idx_orders_table (table_id),
  KEY idx_orders_zalo_user (source, zalo_user_id),
  KEY idx_orders_zalo_chat (zalo_chat_id),
  KEY idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_table FOREIGN KEY (table_id)   REFERENCES dining_tables (id) ON DELETE SET NULL,
  CONSTRAINT fk_orders_user  FOREIGN KEY (created_by) REFERENCES users (id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE dining_tables
  ADD CONSTRAINT fk_tables_current_order FOREIGN KEY (current_order_id) REFERENCES orders (id) ON DELETE SET NULL;

CREATE TABLE order_items (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id     INT UNSIGNED  NOT NULL,
  product_id   INT UNSIGNED  NOT NULL,
  product_name VARCHAR(150)  NOT NULL,            -- snapshot
  unit_price   DECIMAL(14,2) NOT NULL,            -- snapshot
  quantity     SMALLINT UNSIGNED NOT NULL,
  line_total   DECIMAL(14,2) NOT NULL,
  unit_cogs    DECIMAL(14,4) NOT NULL DEFAULT 0,  -- fixed at completion
  line_cogs    DECIMAL(14,2) NOT NULL DEFAULT 0,
  note         VARCHAR(255)  NULL,
  PRIMARY KEY (id),
  KEY idx_items_order (order_id),
  KEY idx_items_product (product_id),
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders (id)   ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id    INT UNSIGNED  NOT NULL,
  method      ENUM('cash','transfer','card','other') NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  reference   VARCHAR(100)  NULL,
  received_by INT UNSIGNED  NULL,
  paid_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_payments_order (order_id),
  KEY idx_payments_paid_at (paid_at),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id)    REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_user  FOREIGN KEY (received_by) REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Stock ledger (every change to inventory_items.quantity_on_hand)
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_movements (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inventory_item_id INT UNSIGNED    NOT NULL,
  movement_type     ENUM('purchase','sale','adjustment','waste','return') NOT NULL,
  quantity_change   DECIMAL(14,3)   NOT NULL,      -- signed
  unit_cost         DECIMAL(14,4)   NOT NULL DEFAULT 0,
  balance_after     DECIMAL(14,3)   NOT NULL,
  order_id          INT UNSIGNED    NULL,
  note              VARCHAR(255)    NULL,
  created_by        INT UNSIGNED    NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mov_item_created (inventory_item_id, created_at),
  KEY idx_mov_order (order_id),
  CONSTRAINT fk_mov_item  FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mov_order FOREIGN KEY (order_id)          REFERENCES orders (id)          ON DELETE SET NULL,
  CONSTRAINT fk_mov_user  FOREIGN KEY (created_by)        REFERENCES users (id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Zalo OA integration
-- -----------------------------------------------------------------------------
-- One conversation row per (chat, sender). In a 1:1 chat chat_id == zalo_user_id;
-- in a group chat chat_id is the group id and the sender who built the draft confirms it.
CREATE TABLE zalo_sessions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chat_type        ENUM('user','group') NOT NULL,
  chat_id          VARCHAR(64)  NOT NULL,
  zalo_user_id     VARCHAR(64)  NOT NULL,
  state            ENUM('idle','awaiting_confirm') NOT NULL DEFAULT 'idle',
  draft_order_id   INT UNSIGNED NULL,
  last_msg_id      VARCHAR(100) NULL,
  last_activity_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       DATETIME     NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_zalo_session (chat_type, chat_id, zalo_user_id),
  KEY idx_zalo_session_draft (draft_order_id),
  KEY idx_zalo_session_expires (expires_at),
  CONSTRAINT fk_zalo_session_order FOREIGN KEY (draft_order_id) REFERENCES orders (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Webhook inbox: idempotency (Zalo retries at +30s/5m/15m/30m/1h) + audit trail
CREATE TABLE zalo_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_key    VARCHAR(100) NOT NULL,              -- "<event_name>:<msg_id>" or sha256(body)
  event_name   VARCHAR(60)  NOT NULL,
  chat_id      VARCHAR(64)  NULL,
  sender_id    VARCHAR(64)  NULL,
  payload      JSON         NOT NULL,
  num_retry    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  status       ENUM('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
  error        VARCHAR(500) NULL,
  received_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_zalo_event_key (event_key),
  KEY idx_zalo_event_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Singleton row (id = 1). Zalo refresh tokens are SINGLE-USE and rotate, so they must be persisted.
CREATE TABLE zalo_tokens (
  id                TINYINT UNSIGNED NOT NULL,
  access_token      TEXT         NOT NULL,
  refresh_token     TEXT         NOT NULL,
  access_expires_at DATETIME     NOT NULL,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Key/value settings edited from the Web Admin (receipt printer, ...). Also created at startup on older
-- databases (src/config/bootstrapDb.js ensureSchemaUpgrades), so it must stay CREATE-IF-NOT-EXISTS-safe.
CREATE TABLE app_settings (
  setting_key   VARCHAR(64)  NOT NULL,
  setting_value TEXT         NULL,
  updated_by    INT UNSIGNED NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Customers (regulars, Zalo buyers who owe). Orders link by zalo_user_id (Zalo orders) for now.
-- Also created at startup on older databases (ensureSchemaUpgrades).
CREATE TABLE customers (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(20)  NULL,
  zalo_user_id  VARCHAR(64)  NULL,
  note          VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_phone (phone),
  UNIQUE KEY uq_customers_zalo (zalo_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Photos uploaded from the Web Admin (products, ingredients), served at /media/<id>-<slug>.<ext>.
-- Kept in the database because a Node.js redeploy replaces public_html. Also created at startup (ensureSchemaUpgrades).
CREATE TABLE media_files (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  folder      VARCHAR(20)  NOT NULL,             -- products | ingredients
  mime        VARCHAR(30)  NOT NULL,
  bytes       MEDIUMBLOB   NOT NULL,
  size        INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Debt ledger (sổ công nợ). Balance of a customer = SUM(amount): a confirmed-but-unpaid order adds a
-- 'debt' row (+total); collecting money adds a 'payment' row (-amount, may be partial); 'adjust' corrects.
-- One debt row and one payment row per order at most (uq_ledger_order); free payments have order_id NULL.
CREATE TABLE customer_ledger (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id  INT UNSIGNED  NOT NULL,
  order_id     INT UNSIGNED  NULL,
  entry_type   ENUM('debt','payment','adjust') NOT NULL,
  amount       DECIMAL(14,2) NOT NULL,
  method       ENUM('cash','transfer','card','other') NULL,
  note         VARCHAR(255)  NULL,
  created_by   INT UNSIGNED  NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_order (order_id, entry_type),
  KEY idx_ledger_customer (customer_id, created_at),
  CONSTRAINT fk_ledger_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_order    FOREIGN KEY (order_id)    REFERENCES orders (id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
