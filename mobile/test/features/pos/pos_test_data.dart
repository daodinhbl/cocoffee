import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

/// Realistic fake responses of the POS endpoints (GET /api/pos/bootstrap, /api/zalo/drafts, /api/orders/:id).

List<Map<String, dynamic>> get drafts => [
  {
    'id': 7,
    'chat_type': 'user',
    'last_activity_at': '2026-10-14T02:30:00.000Z',
    'expires_at': DateTime.now().toUtc().add(const Duration(minutes: 20, seconds: 30)).toIso8601String(),
    'order_id': 42,
    'order_code': 'CF261014-00042',
    'total': 54000,
  },
];

Map<String, dynamic> bootstrap() => {
      'categories': [
        {'id': 1, 'code': 'cafe', 'name': 'Cà phê'},
        {'id': 2, 'code': 'tra', 'name': 'Trà'},
        {'id': 3, 'code': 'banh', 'name': 'Bánh ngọt'},
      ],
      'products': [
        {'id': 11, 'category_id': 1, 'name': 'Cà phê sữa đá', 'price': 25000, 'image_url': null},
        {'id': 12, 'category_id': 1, 'name': 'Bạc xỉu', 'price': 29000, 'image_url': null},
        {'id': 21, 'category_id': 2, 'name': 'Trà đào cam sả', 'price': 35000, 'image_url': ''},
      ],
      'tables': [
        {'id': 1, 'code': 'B01', 'name': 'Bàn 1', 'status': 'available', 'current_order_id': null, 'current_order_total': null},
        {'id': 2, 'code': 'B02', 'name': 'Bàn 2', 'status': 'serving', 'current_order_id': 55, 'current_order_total': 79000},
        {'id': 3, 'code': 'B03', 'name': '', 'status': 'available', 'current_order_id': null, 'current_order_total': null},
      ],
      'drafts': drafts,
      'zalo': {'state': 'ok', 'label': 'Zalo bot OK'},
      'printer': {'autoPrint': true, 'vatRate': 8, 'paperMm': 80},
    };

Map<String, dynamic> order55() => {
      'order': {
        'id': 55,
        'order_code': 'CF261014-00055',
        'table_id': 2,
        'table_name': 'Bàn 2',
        'source': 'pos',
        'status': 'open',
        'payment_status': 'unpaid',
        'subtotal': 79000,
        'discount': 0,
        'total': 79000,
        'note': null,
        'items': [
          {'id': 1, 'order_id': 55, 'product_id': 11, 'product_name': 'Cà phê sữa đá', 'unit_price': 25000, 'quantity': 2, 'line_total': 50000, 'note': 'ít đá'},
          {'id': 2, 'order_id': 55, 'product_id': 12, 'product_name': 'Bạc xỉu', 'unit_price': 29000, 'quantity': 1, 'line_total': 29000, 'note': null},
        ],
      },
    };

Map<String, dynamic> orderRes(int id, String status, num total) => {
      'order': {'id': id, 'order_code': 'CF261014-${id.toString().padLeft(5, '0')}', 'status': status, 'total': total, 'items': const []},
    };

/// Stubs the two reads every POS screen makes on open.
void stubPosReads(MockApi api) {
  when(() => api.get('/pos/bootstrap', query: any(named: 'query'))).thenAnswer((_) async => bootstrap());
  when(() => api.get('/zalo/drafts', query: any(named: 'query'))).thenAnswer((_) async => {'drafts': drafts});
}
