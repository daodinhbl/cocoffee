import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/core/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../helpers/test_app.dart';

/// Realistic API payloads (shapes from api.json: GET /api/orders extended list, GET /api/orders/:id?include=payments).

Map<String, dynamic> orderRow({
  required int id,
  String source = 'pos',
  String status = 'completed',
  String paymentStatus = 'paid',
  String? paymentMethod = 'cash',
  num total = 54000,
  String? tableCode,
  int? customerId,
  String? customerName,
  num itemCount = 2,
  String createdAt = '2026-10-14T02:30:00.000Z',
  String? receiptError,
}) =>
    {
      'id': id,
      'order_code': 'CF261014-${id.toString().padLeft(5, '0')}',
      'source': source,
      'status': status,
      'payment_status': paymentStatus,
      'payment_method': paymentMethod,
      'total': total,
      'cogs_total': total * 0.3,
      'table_id': tableCode == null ? null : 3,
      'table_code': tableCode,
      'zalo_user_id': source == 'zalo' ? '8812' : null,
      'zalo_chat_type': source == 'zalo' ? 'user' : null,
      'note': null,
      'receipt_sent_at': null,
      'receipt_error': receiptError,
      'created_at': createdAt,
      'completed_at': status == 'completed' ? createdAt : null,
      'customer_id': customerId,
      'customer_name': customerName,
      'item_count': itemCount,
    };

Map<String, dynamic> ordersResponse({List<Map<String, dynamic>>? orders, int total = 60, int page = 1, int pages = 3}) => {
      'orders': orders ??
          [
            orderRow(id: 12, tableCode: 'B03', total: 79000, status: 'open', paymentStatus: 'unpaid', paymentMethod: null, itemCount: 3),
            orderRow(id: 11, source: 'zalo', status: 'completed', paymentStatus: 'unpaid', paymentMethod: null, total: 120000,
                customerId: 5, customerName: 'Chị Lan', receiptError: 'Zalo API timeout'),
            orderRow(id: 10, source: 'zalo', status: 'draft', paymentStatus: 'unpaid', paymentMethod: null, total: 45000, itemCount: 1),
            orderRow(id: 9, total: 54000),
            orderRow(id: 8, status: 'cancelled', paymentStatus: 'unpaid', paymentMethod: null, total: 30000),
          ],
      'total': total,
      'page': page,
      'pages': pages,
      'page_size': 25,
      'counts': {
        'all': 60,
        'draft': 4,
        'open': 3,
        'completed': 50,
        'cancelled': 3,
        'unpaid': 2,
        'revenue': 975000,
        'unpaidAmount': 165000,
        'openAmount': 210000,
      },
    };

Map<String, dynamic> item(int id, String name, num price, num quantity, {String? note}) => {
      'id': id,
      'order_id': 42,
      'product_id': id + 100,
      'product_name': name,
      'unit_price': price,
      'quantity': quantity,
      'line_total': price * quantity,
      'unit_cogs': 0,
      'line_cogs': 0,
      'note': note,
    };

/// An open POS order at table 3: 2 x Cà phê sữa đá (note) + 1 x Bạc xỉu = 79.000đ.
Map<String, dynamic> openOrderResponse() => {
      'order': {
        'id': 42,
        'order_code': 'CF261014-00042',
        'table_id': 3,
        'source': 'pos',
        'zalo_user_id': null,
        'zalo_chat_type': null,
        'status': 'open',
        'payment_status': 'unpaid',
        'payment_method': null,
        'subtotal': 79000,
        'discount': 0,
        'total': 79000,
        'cogs_total': 0,
        'note': 'Khách quen, mang ra sân',
        'customer_id': null,
        'created_by': 1,
        'paid_at': null,
        'completed_at': null,
        'receipt_sent_at': null,
        'receipt_error': null,
        'created_at': '2026-10-14T02:30:00.000Z',
        'updated_at': '2026-10-14T02:31:00.000Z',
        'table_code': 'B03',
        'table_name': 'Bàn 3',
        'items': [
          item(1, 'Cà phê sữa đá', 25000, 2, note: 'Ít đá, ít ngọt'),
          item(2, 'Bạc xỉu', 29000, 1),
        ],
      },
      'payments': <Map<String, dynamic>>[],
    };

/// A delivered Zalo order not paid yet, linked to customer 5 (debt), receipt failed.
Map<String, dynamic> zaloUnpaidResponse() => {
      'order': {
        'id': 77,
        'order_code': 'CF261013-00077',
        'table_id': null,
        'source': 'zalo',
        'zalo_user_id': '8812',
        'zalo_chat_type': 'group',
        'status': 'completed',
        'payment_status': 'unpaid',
        'payment_method': null,
        'subtotal': 120000,
        'discount': 0,
        'total': 120000,
        'cogs_total': 36000,
        'note': null,
        'customer_id': 5,
        'customer_name': 'Chị Lan',
        'paid_at': null,
        'completed_at': '2026-10-13T03:10:00.000Z',
        'receipt_sent_at': null,
        'receipt_error': 'Zalo API timeout',
        'created_at': '2026-10-13T03:00:00.000Z',
        'table_code': null,
        'table_name': null,
        'items': [
          item(5, 'Trà đào cam sả', 40000, 3, note: 'Size L, 50% đường'),
        ],
      },
      'payments': <Map<String, dynamic>>[],
    };

/// A paid POS order with its payment row.
Map<String, dynamic> paidOrderResponse() => {
      'order': {
        'id': 9,
        'order_code': 'CF261014-00009',
        'source': 'pos',
        'status': 'completed',
        'payment_status': 'paid',
        'payment_method': 'cash',
        'subtotal': 79000,
        'discount': 4000,
        'total': 75000,
        'cogs_total': 30000,
        'note': null,
        'customer_id': null,
        'paid_at': '2026-10-14T03:00:00.000Z',
        'completed_at': '2026-10-14T03:00:00.000Z',
        'receipt_sent_at': null,
        'receipt_error': null,
        'created_at': '2026-10-14T02:30:00.000Z',
        'table_code': 'B01',
        'table_name': 'Bàn 1',
        'items': [
          item(1, 'Cà phê sữa đá', 25000, 2),
          item(2, 'Bạc xỉu', 29000, 1),
        ],
      },
      'payments': [
        {'id': 1, 'method': 'cash', 'amount': 75000, 'reference': null, 'paid_at': '2026-10-14T03:00:00.000Z', 'received_by_name': 'Thu Ngân'},
      ],
    };

/// Like testApp() but with a real GoRouter, to check context.push targets.
Future<Widget> routerTestApp(GoRouter router, {required ApiClient api, AppUser user = adminUser}) async {
  SharedPreferences.setMockInitialValues({});
  final store = SessionStore(await SharedPreferences.getInstance());
  return ProviderScope(
    overrides: [
      sessionStoreProvider.overrideWithValue(store),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(user),
    ],
    child: MaterialApp.router(
      theme: buildTheme(Brightness.light),
      locale: const Locale('vi'),
      supportedLocales: const [Locale('vi')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: router,
    ),
  );
}

/// A stub page showing the location it was opened with.
Widget stubPage(GoRouterState s) => Scaffold(body: Text('stub ${s.uri}'));

/// A delivered Zalo order not paid yet and NOT on any customer's ledger (candidate for "Ghi công nợ").
Map<String, dynamic> zaloUnlinkedResponse() {
  final r = zaloUnpaidResponse();
  final o = Map<String, dynamic>.from(r['order'] as Map)
    ..['id'] = 78
    ..['order_code'] = 'CF261014-00078'
    ..['zalo_user_id'] = '8813'
    ..['zalo_chat_type'] = 'user'
    ..['customer_id'] = null
    ..['customer_name'] = null;
  return {'order': o, 'payments': <Map<String, dynamic>>[]};
}
