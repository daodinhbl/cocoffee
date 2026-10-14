/// Fake API payloads shaped like the contract (api.json "gaps"): snake_case keys, DECIMAL as numbers, 0/1 flags,
/// ISO UTC dates.
library;

Map<String, dynamic> inventoryAllResponse() => {
      'items': [
        {
          'id': 1, 'sku': 'CF-ROBUSTA', 'name': 'Cà phê Robusta', 'unit': 'g', 'quantity_on_hand': 3525, 'avg_cost': 280,
          'min_stock': 3000, 'is_active': 1, 'is_low': 0, 'stock_value': 987000, 'image_url': null,
        },
        {
          'id': 2, 'sku': 'SUA-DAC', 'name': 'Sữa đặc Ông Thọ', 'unit': 'lon', 'quantity_on_hand': 4, 'avg_cost': 26000,
          'min_stock': 6, 'is_active': 1, 'is_low': 1, 'stock_value': 104000, 'image_url': '',
        },
        {
          'id': 3, 'sku': 'SUA-TUOI', 'name': 'Sữa tươi Vinamilk', 'unit': 'ml', 'quantity_on_hand': 0, 'avg_cost': 32,
          'min_stock': 2000, 'is_active': 1, 'is_low': 1, 'stock_value': 0, 'image_url': null,
        },
        {
          'id': 4, 'sku': 'TRA-DEN', 'name': 'Trà đen', 'unit': 'g', 'quantity_on_hand': 1500, 'avg_cost': 450,
          'min_stock': 500, 'is_active': 1, 'is_low': 0, 'stock_value': 675000, 'image_url': '/media/4-tra-den.jpg',
        },
        {
          'id': 5, 'sku': 'SIRO-DAO', 'name': 'Siro đào', 'unit': 'ml', 'quantity_on_hand': 800, 'avg_cost': 120,
          'min_stock': 0, 'is_active': 0, 'is_low': 0, 'stock_value': 96000, 'image_url': null,
        },
      ],
      'stock_value': 1766000,
    };

/// GET /api/inventory (staff): active items only, no stock_value / image_url.
Map<String, dynamic> inventoryActiveResponse() => {
      'items': [
        for (final i in inventoryAllResponse()['items'] as List)
          if ((i as Map)['is_active'] == 1)
            {for (final e in i.entries) if (e.key != 'stock_value' && e.key != 'image_url') e.key: e.value},
      ],
    };

Map<String, dynamic> inventoryDetailResponse() => {
      'item': {
        'id': 1, 'sku': 'CF-ROBUSTA', 'name': 'Cà phê Robusta', 'unit': 'g', 'quantity_on_hand': 3525, 'avg_cost': 280,
        'min_stock': 3000, 'is_active': 1, 'image_url': null,
        'created_at': '2026-10-01T02:00:00.000Z', 'updated_at': '2026-10-14T03:15:00.000Z',
      },
      'usage': {
        'days': 30, 'used': 2400, 'wasted': 200, 'received': 4000,
        'lastPurchase': {'quantity': 2000, 'unit_cost': 285, 'created_at': '2026-10-10T02:30:00.000Z'},
      },
      'used_in': [
        {'id': 11, 'name': 'Cà phê sữa đá', 'sku': 'CF-SUA-DA', 'price': 29000, 'is_active': 1, 'image_url': '', 'stock_mode': 'bom', 'quantity': 25},
        {'id': 12, 'name': 'Bạc xỉu', 'sku': 'BAC-XIU', 'price': 32000, 'is_active': 1, 'image_url': null, 'stock_mode': 'bom', 'quantity': 18},
        {'id': 13, 'name': 'Cà phê đen nóng', 'sku': 'CF-DEN', 'price': 22000, 'is_active': 0, 'image_url': null, 'stock_mode': 'bom', 'quantity': 20},
      ],
      'movements': [
        {
          'id': 106, 'movement_type': 'sale', 'quantity_change': -25, 'unit_cost': 280, 'balance_after': 3525, 'order_id': 4210,
          'note': 'CF261014-04210', 'created_at': '2026-10-14T03:15:00.000Z', 'created_by_name': null,
        },
        {
          'id': 105, 'movement_type': 'adjustment', 'quantity_change': -200, 'unit_cost': 280, 'balance_after': 3550, 'order_id': null,
          'note': 'Kiểm kê cuối tuần', 'created_at': '2026-10-13T14:00:00.000Z', 'created_by_name': 'Chủ Quán',
        },
        {
          'id': 104, 'movement_type': 'sale', 'quantity_change': -50, 'unit_cost': 280, 'balance_after': 3750, 'order_id': 4180,
          'note': null, 'created_at': '2026-10-13T08:20:00.000Z', 'created_by_name': null,
        },
        {
          'id': 103, 'movement_type': 'purchase', 'quantity_change': 2000, 'unit_cost': 285, 'balance_after': 3800, 'order_id': null,
          'note': 'NCC Thành Phát · HĐ 0012', 'created_at': '2026-10-10T02:30:00.000Z', 'created_by_name': 'Chủ Quán',
        },
        {
          'id': 102, 'movement_type': 'waste', 'quantity_change': -200, 'unit_cost': 0, 'balance_after': 1800, 'order_id': null,
          'note': 'Ẩm mốc', 'created_at': '2026-10-05T09:00:00.000Z', 'created_by_name': 'Chủ Quán',
        },
        {
          'id': 101, 'movement_type': 'purchase', 'quantity_change': 2000, 'unit_cost': 278, 'balance_after': 2000, 'order_id': null,
          'note': 'Tồn đầu kỳ', 'created_at': '2026-10-01T02:00:00.000Z', 'created_by_name': 'Chủ Quán',
        },
      ],
    };

Map<String, dynamic> purchasesResponse() => {
      'purchases': [
        {
          'id': 103, 'inventory_item_id': 1, 'item_name': 'Cà phê Robusta', 'unit': 'g', 'quantity_change': 2000, 'unit_cost': 285,
          'balance_after': 3800, 'note': 'NCC Thành Phát · HĐ 0012', 'created_at': '2026-10-10T02:30:00.000Z', 'user_name': 'Chủ Quán',
        },
        {
          'id': 99, 'inventory_item_id': 2, 'item_name': 'Sữa đặc Ông Thọ', 'unit': 'lon', 'quantity_change': 24, 'unit_cost': 26000,
          'balance_after': 30, 'note': null, 'created_at': '2026-10-08T01:10:00.000Z', 'user_name': null,
        },
      ],
    };
