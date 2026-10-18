-- Xoa toan bo du lieu nghiep vu cua CoCoffee (DB u464927386_cocoffee).
-- GIU LAI: cau truc bang, tai khoan 'admin', bang app_settings (cai dat + dau seed.menu_v1).
-- Giu 1 dong users de bootstrapDb khong coi DB la "trong" va khong seed lai khi khoi dong.
-- CHAY SAU KHI DA XUAT BAN SAO LUU (.sql) TRONG phpMyAdmin. Khong hoan tac duoc.

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE payments;
TRUNCATE TABLE payon_payments;
TRUNCATE TABLE order_items;
TRUNCATE TABLE orders;
TRUNCATE TABLE inventory_movements;
TRUNCATE TABLE customer_ledger;
TRUNCATE TABLE customers;
TRUNCATE TABLE recipes;
TRUNCATE TABLE product_aliases;
TRUNCATE TABLE products;
TRUNCATE TABLE categories;
TRUNCATE TABLE inventory_items;
TRUNCATE TABLE dining_tables;
TRUNCATE TABLE media_files;
TRUNCATE TABLE zalo_sessions;
TRUNCATE TABLE zalo_events;
TRUNCATE TABLE zalo_tokens;
TRUNCATE TABLE idempotency_keys;
TRUNCATE TABLE audit_log;

DELETE FROM users WHERE username <> 'admin';

SET FOREIGN_KEY_CHECKS = 1;
