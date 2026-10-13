-- =============================================================================
--  Sample data (demo prices/costs - replace with your own). Run AFTER schema.sql.
--  alias_norm must be lowercase without diacritics (same rule as src/utils/text.js).
-- =============================================================================
SET NAMES utf8mb4;

-- !!! DEFAULT LOGIN  admin / admin  (bcrypt hash below) !!!
-- Change it right after the first login:  POST /api/auth/change-password
-- Never leave admin/admin on a public domain.
INSERT INTO users (username, password_hash, full_name, role) VALUES
  ('admin', '$2b$12$GDiiHiBb94/7lNFEsMz1TOlRY.CNpPPerGLq4fnnvVA3euMaRqx0y', 'Administrator', 'admin')
ON DUPLICATE KEY UPDATE username = username;

INSERT INTO categories (id, code, name, sort_order) VALUES
  (1, 'mixed_drink',   'Đồ uống pha chế', 1),
  (2, 'cigarette',     'Thuốc lá',        2),
  (3, 'bottled_water', 'Nước đóng chai',  3);

-- avg_cost = VND per ONE base unit (g / ml / pcs / pack / bottle), e.g. coffee 280.000đ/kg = 280đ/g
INSERT INTO inventory_items (id, sku, name, unit, quantity_on_hand, avg_cost, min_stock) VALUES
  (1,  'RM-COFFEE',   'Cà phê rang xay',      'g',      5000,  280.0000,  500),
  (2,  'RM-MILK-CON', 'Sữa đặc',              'g',      4000,  70.0000,  500),
  (3,  'RM-MILK-FRS', 'Sữa tươi',             'ml',     6000,  30.0000,  500),
  (4,  'RM-SYR-PEACH','Syrup đào',            'ml',     2000,  90.0000,  300),
  (5,  'RM-TEA',      'Trà đen',              'g',      1000,  180.0000,  100),
  (6,  'RM-SYR-SUGAR','Đường nước',           'ml',     3000,  20.0000,  300),
  (7,  'RM-ICE',      'Đá viên',              'g',     40000,  2.0000, 3000),
  (8,  'RM-CUP',      'Ly nhựa + nắp',        'pcs',     500,  900.0000, 50),
  (9,  'RM-PEACH',    'Đào miếng ngâm',       'pcs',     200,  3000.0000, 20),
  (10, 'GD-555',      'Thuốc lá 555',         'pack',     60,  38000.0000, 10),
  (11, 'GD-MARLBORO', 'Thuốc lá Marlboro',    'pack',     40,  33000.0000, 10),
  (12, 'GD-THANGLONG','Thuốc lá Thăng Long',  'pack',     40,  22000.0000, 10),
  (13, 'GD-AQUAFINA', 'Nước Aquafina 500ml',  'bottle',  100,  4500.0000, 24),
  (14, 'GD-LAVIE',    'Nước Lavie 500ml',     'bottle',  100,  4000.0000, 24);

INSERT INTO products (id, category_id, sku, name, price, stock_mode, inventory_item_id) VALUES
  (1,  1, 'CF-DEN-DA', 'Cà phê đen đá', 20000, 'bom',    NULL),
  (2,  1, 'CF-SUA-DA', 'Cà phê sữa đá', 25000, 'bom',    NULL),
  (3,  1, 'BAC-XIU',   'Bạc xỉu',       29000, 'bom',    NULL),
  (4,  1, 'TRA-DAO',   'Trà đào',       35000, 'bom',    NULL),
  (5,  1, 'TRA-DA',    'Trà đá',         8000, 'bom',    NULL),
  (6,  2, '555',       'Thuốc lá 555',          45000, 'direct', 10),
  (7,  2, 'MARLBORO',  'Thuốc lá Marlboro',     40000, 'direct', 11),
  (8,  2, 'THANGLONG', 'Thuốc lá Thăng Long',   27000, 'direct', 12),
  (9,  3, 'AQUAFINA',  'Nước Aquafina 500ml',   10000, 'direct', 13),
  (10, 3, 'LAVIE',     'Nước Lavie 500ml',      10000, 'direct', 14);

-- BOM (per 1 unit sold)
INSERT INTO recipes (product_id, inventory_item_id, quantity) VALUES
  (1, 1, 18), (1, 6, 10), (1, 7, 150), (1, 8, 1),
  (2, 1, 18), (2, 2, 30), (2, 7, 150), (2, 8, 1),
  (3, 1, 10), (3, 2, 25), (3, 3, 60),  (3, 7, 150), (3, 8, 1),
  (4, 5, 8),  (4, 4, 30), (4, 9, 2),   (4, 6, 15),  (4, 7, 150), (4, 8, 1),
  (5, 5, 5),  (5, 7, 150), (5, 8, 1);

INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES
  (1, 'Cà phê đen đá', 'ca phe den da'), (1, 'cà phê đen', 'ca phe den'), (1, 'cafe đen', 'cafe den'), (1, 'cf đen', 'cf den'),
  (2, 'Cà phê sữa đá', 'ca phe sua da'), (2, 'cà phê sữa', 'ca phe sua'), (2, 'cafe sữa', 'cafe sua'), (2, 'cf sữa', 'cf sua'), (2, 'nâu đá', 'nau da'),
  (3, 'Bạc xỉu', 'bac xiu'), (3, 'bạc sỉu', 'bac siu'),
  (4, 'Trà đào', 'tra dao'), (4, 'trà đào cam sả', 'tra dao cam sa'),
  (5, 'Trà đá', 'tra da'),
  (6, 'Thuốc lá 555', 'thuoc la 555'), (6, '555', '555'), (6, 'thuốc 555', 'thuoc 555'),
  (7, 'Thuốc lá Marlboro', 'thuoc la marlboro'), (7, 'marlboro', 'marlboro'), (7, 'thuốc marlboro', 'thuoc marlboro'), (7, 'malboro', 'malboro'),
  (8, 'Thuốc lá Thăng Long', 'thuoc la thang long'), (8, 'thăng long', 'thang long'), (8, 'thuốc thăng long', 'thuoc thang long'),
  (9, 'Nước Aquafina 500ml', 'nuoc aquafina 500ml'), (9, 'aquafina', 'aquafina'), (9, 'nước aquafina', 'nuoc aquafina'),
  (10,'Nước Lavie 500ml', 'nuoc lavie 500ml'), (10, 'lavie', 'lavie'), (10, 'nước lavie', 'nuoc lavie');

INSERT INTO dining_tables (code, name, capacity) VALUES
  ('T01','Bàn 1',4), ('T02','Bàn 2',4), ('T03','Bàn 3',4), ('T04','Bàn 4',4), ('T05','Bàn 5',6),
  ('T06','Bàn 6',6), ('T07','Bàn 7',2), ('T08','Bàn 8',2), ('T09','Bàn 9',8), ('T10','Bàn 10',8);
