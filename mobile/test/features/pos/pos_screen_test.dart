import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/pos/pos_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'pos_test_data.dart';

void main() {
  group('phone', () {
    testWidgets('cashier searches, filters, fills the cart and pays cash with change', (tester) async {
      await setSurface(tester, phone);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.post('/pos/checkout', any(), any()))
          .thenAnswer((_) async => {...orderRes(101, 'completed', 50000), 'change': 50000});

      await tester.pumpWidget(await testApp(const PosScreen(), api: api, user: cashierUser));
      await tester.pumpAndSettle();

      expect(find.text('Bán hàng POS'), findsOneWidget);
      expect(find.text('Thu Ngân · Thu ngân'), findsOneWidget);
      expect(find.byTooltip('Đơn hàng'), findsNothing); // admin-only shortcut
      expect(find.text('Tất cả'), findsOneWidget);
      expect(find.text('Bánh ngọt'), findsNothing); // category without products is hidden
      expect(find.text('Cà phê sữa đá'), findsOneWidget);
      expect(find.text('25.000đ'), findsOneWidget);

      // Accent-insensitive search, then the category tab.
      await tester.enterText(find.byType(TextField), 'tra dao');
      await tester.pump();
      expect(find.text('Trà đào cam sả'), findsOneWidget);
      expect(find.text('Bạc xỉu'), findsNothing);
      await tester.tap(find.byTooltip('Xóa tìm kiếm'));
      await tester.pump();
      await tester.tap(find.text('Cà phê'));
      await tester.pump();
      expect(find.text('Trà đào cam sả'), findsNothing);
      expect(find.text('Bạc xỉu'), findsOneWidget);

      await tester.tap(find.text('Cà phê sữa đá'));
      await tester.pump();
      await tester.tap(find.text('Cà phê sữa đá'));
      await tester.pump();
      expect(find.text('2 món'), findsOneWidget); // sticky summary on the Món tab
      expect(find.text('50.000đ'), findsOneWidget);
      expect(find.text('2'), findsNWidgets(2)); // count bubble on the card + badge on 'Giỏ'

      await tester.tap(find.text('Giỏ'));
      await tester.pumpAndSettle();
      expect(find.text('Đơn hiện tại'), findsOneWidget);
      expect(find.text('Đơn mới · 2 món'), findsOneWidget);
      expect(find.text('Mang đi'), findsOneWidget);
      expect(find.text('Khách mang đi · chạm để chọn bàn'), findsOneWidget);
      expect(find.text('25.000đ / món'), findsOneWidget);
      expect(find.text('Trong đó VAT (8%)'), findsOneWidget);
      expect(find.text('Xóa giỏ'), findsOneWidget);

      await tester.tap(find.text('THANH TOÁN'));
      await tester.pumpAndSettle();
      expect(find.text('Thanh toán'), findsOneWidget);
      expect(find.text('Mang đi · 2 món'), findsOneWidget);
      expect(find.text('Đủ tiền'), findsOneWidget);
      expect(find.text('Tiền thối'), findsOneWidget);
      await tester.tap(find.text('100.000đ'));
      await tester.pump();
      expect(find.text('50.000đ'), findsWidgets); // change = 100.000 − 50.000

      await tester.tap(find.text('XÁC NHẬN THANH TOÁN'));
      await tester.pumpAndSettle();

      // one request saves the cart and takes the payment; the Idempotency-Key makes a retry safe
      final call = verify(() => api.post('/pos/checkout', captureAny(), captureAny())).captured;
      expect(call[0], {
        'items': [
          {'product_id': 11, 'quantity': 2},
        ],
        'method': 'cash',
        'tendered': 100000,
        'discount': 0,
      });
      expect((call[1] as Map)['Idempotency-Key'], startsWith('off-'));
      expect(find.text('Đã thanh toán CF261014-00101. Thối 50.000đ.'), findsOneWidget);
      expect(find.text('Thanh toán'), findsNothing); // sheet closed
      expect(find.text('2 món'), findsNothing); // cart emptied
    });

    testWidgets('admin opens a serving table, edits a line and saves the open order', (tester) async {
      await setSurface(tester, phone);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.get('/orders/55', query: any(named: 'query'))).thenAnswer((_) async => order55());
      when(() => api.post('/pos/hold', any(), any())).thenAnswer((_) async => orderRes(55, 'open', 108000));

      await tester.pumpWidget(await testApp(const PosScreen(), api: api));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Đơn hàng'), findsOneWidget);

      await tester.tap(find.text('Bàn'));
      await tester.pumpAndSettle();
      expect(find.text('Chọn bàn'), findsOneWidget);
      expect(find.text('Trống'), findsNWidgets(3)); // legend + Bàn 1 + B03
      expect(find.text('Đang phục vụ (chạm để mở đơn)'), findsOneWidget);
      expect(find.text('Mang đi'), findsOneWidget);
      expect(find.text('Không dùng bàn'), findsOneWidget);
      expect(find.text('B03'), findsOneWidget); // name || code
      expect(find.text('Đang phục vụ'), findsOneWidget);
      expect(find.text('79.000đ'), findsOneWidget);

      await tester.tap(find.text('Bàn 2'));
      await tester.pumpAndSettle();
      expect(find.text('Đã mở đơn CF261014-00055 của Bàn 2'), findsOneWidget);
      expect(find.text('CF261014-00055 · 3 món'), findsOneWidget);
      expect(find.text('Đang phục vụ · CF261014-00055'), findsOneWidget);
      expect(find.text('ít đá'), findsOneWidget);
      expect(find.text('Lưu đơn'), findsOneWidget);
      expect(find.text('Hủy đơn'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3)); // let the toast go
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byTooltip('Tăng Bạc xỉu'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Tăng Bạc xỉu'));
      await tester.pump();
      expect(find.text('58.000đ'), findsOneWidget);

      await tester.tap(find.text('Lưu đơn'));
      await tester.pumpAndSettle();
      final hold = verify(() => api.post('/pos/hold', captureAny(), any())).captured.single;
      expect(hold, {
        'order_id': 55,
        'items': [
          {'product_id': 11, 'quantity': 2, 'note': 'ít đá'},
          {'product_id': 12, 'quantity': 2},
        ],
      });
      expect(find.text('Đã lưu đơn CF261014-00055 cho bàn.'), findsOneWidget);
      expect(find.text('Chọn bàn'), findsOneWidget); // back on the table map
    });

    testWidgets('admin cancels the open order of a table', (tester) async {
      await setSurface(tester, phone);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.get('/orders/55', query: any(named: 'query'))).thenAnswer((_) async => order55());
      when(() => api.post('/orders/55/cancel', any())).thenAnswer((_) async => orderRes(55, 'cancelled', 79000));

      await tester.pumpWidget(await testApp(const PosScreen(tableId: 2), api: api));
      await tester.pumpAndSettle();
      // /pos?table=2 opens the table's current order straight away.
      expect(find.text('CF261014-00055 · 3 món'), findsOneWidget);

      await tester.tap(find.text('Hủy đơn'));
      await tester.pumpAndSettle();
      expect(find.text('Hủy đơn CF261014-00055?'), findsOneWidget);
      await tester.tap(find.text('Hủy đơn').last);
      await tester.pumpAndSettle();

      verify(() => api.post('/orders/55/cancel', any())).called(1);
      expect(find.text('Đã hủy đơn CF261014-00055.'), findsOneWidget);
    });

    testWidgets('Zalo inbox: confirmed order is collected by card, bill can be resent', (tester) async {
      await setSurface(tester, phone);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.get('/orders', query: any(named: 'query'))).thenAnswer((_) async => {
            'orders': [
              {
                'id': 77,
                'order_code': 'CF261014-00077',
                'source': 'zalo',
                'status': 'completed',
                'payment_status': 'unpaid',
                'total': 64000,
                'customer_id': null,
                'customer_name': null,
                'item_count': 2,
                'completed_at': '2026-10-14T03:10:00.000Z',
                'receipt_error': 'Zalo API 500',
              },
              {'id': 78, 'order_code': 'CF261014-00078', 'source': 'zalo', 'status': 'completed', 'payment_status': 'paid', 'total': 1},
            ],
          });
      when(() => api.post('/orders/77/pay', any())).thenAnswer((_) async => {...orderRes(77, 'completed', 64000), 'change': 0});
      when(() => api.post('/orders/77/resend-receipt', any())).thenAnswer((_) async => {'sent': true});

      await tester.pumpWidget(await testApp(const PosScreen(), api: api, user: cashierUser));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Giỏ'));
      await tester.pumpAndSettle();
      expect(find.text('Có 1 đơn Zalo đang chờ xác nhận'), findsOneWidget);
      await tester.tap(find.text('Có 1 đơn Zalo đang chờ xác nhận'));
      await tester.pumpAndSettle();

      expect(find.text('Đơn Zalo chờ khách xác nhận'), findsOneWidget);
      expect(find.text('CF261014-00042'), findsOneWidget);
      expect(find.textContaining('Chat riêng · 09:30 · còn 21 phút'), findsOneWidget);
      expect(find.text('54.000đ'), findsOneWidget);

      await tester.tap(find.text('Chờ thu tiền'));
      await tester.pumpAndSettle();
      final q = verify(() => api.get('/orders', query: captureAny(named: 'query'))).captured.last;
      expect(q, {'source': 'zalo', 'status': 'completed', 'payment': 'unpaid', 'limit': 50});
      expect(find.text('CF261014-00077'), findsOneWidget);
      expect(find.text('CF261014-00078'), findsNothing); // paid rows are filtered out
      expect(find.text('Khách đã xác nhận'), findsOneWidget);
      expect(find.text('Chưa gửi bill'), findsOneWidget);

      await tester.tap(find.text('Gửi lại'));
      await tester.pumpAndSettle();
      verify(() => api.post('/orders/77/resend-receipt', any())).called(1);

      await tester.tap(find.text('Thu tiền'));
      await tester.pumpAndSettle();
      expect(find.text('CF261014-00077 · Khách Zalo'), findsOneWidget);
      expect(find.text('Mã tham chiếu'), findsOneWidget); // no discount on a completed order
      await tester.tap(find.text('Thẻ'));
      await tester.pump();
      await tester.tap(find.text('XÁC NHẬN THANH TOÁN'));
      await tester.pumpAndSettle();

      final body = verify(() => api.post('/orders/77/pay', captureAny())).captured.single;
      expect(body, {'method': 'card'});
      expect(find.text('Đã thanh toán CF261014-00077.'), findsOneWidget);
    });
  });

  testWidgets('landscape phone and small tablet use the tab layout without overflow', (tester) async {
    for (final size in const [Size(891, 411), Size(700, 1000)]) {
      await setSurface(tester, size);
      final api = MockApi();
      stubPosReads(api);
      await tester.pumpWidget(await testApp(const PosScreen(), api: api, user: cashierUser));
      await tester.pumpAndSettle();
      expect(find.byType(NavigationBar), findsOneWidget);
      await tester.tap(find.text('Cà phê sữa đá'));
      await tester.pump();
      for (final tab in ['Giỏ', 'Bàn', 'Món']) {
        await tester.tap(find.text(tab));
        await tester.pumpAndSettle();
      }
      await tester.tap(find.text('Giỏ'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('THANH TOÁN'));
      await tester.pumpAndSettle();
      expect(find.text('XÁC NHẬN THANH TOÁN'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    }
  });

  group('tablet', () {
    testWidgets('admin: side-by-side layout, holds a new order for a free table with a line note, cancels a Zalo draft',
        (tester) async {
      await setSurface(tester, tablet);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.post('/pos/hold', any(), any())).thenAnswer((_) async => orderRes(102, 'open', 35000));
      when(() => api.get('/orders/42', query: any(named: 'query'))).thenAnswer((_) async => {
            'order': {
              'id': 42,
              'order_code': 'CF261014-00042',
              'status': 'draft',
              'note': null,
              'items': [
                {'product_id': 11, 'product_name': 'Cà phê sữa đá', 'quantity': 2, 'line_total': 50000, 'note': null},
              ],
            },
          });
      when(() => api.post('/orders/42/cancel', any())).thenAnswer((_) async => orderRes(42, 'cancelled', 54000));

      await tester.pumpWidget(await testApp(const PosScreen(), api: api));
      await tester.pumpAndSettle();

      // Product grid and cart panel at the same time, admin shortcuts and the user chip in the header.
      expect(find.text('Cà phê sữa đá'), findsOneWidget);
      expect(find.text('Đơn hiện tại'), findsOneWidget);
      expect(find.text('Quản lý'), findsOneWidget);
      expect(find.text('Đơn hàng'), findsOneWidget);
      expect(find.text('Chủ Quán'), findsOneWidget);
      expect(find.text('Quản trị'), findsOneWidget);
      expect(find.text('Zalo bot OK'), findsOneWidget);
      expect(find.byTooltip('Đăng xuất'), findsOneWidget);
      expect(find.text('Có 1 đơn Zalo đang chờ xác nhận'), findsOneWidget);
      expect(find.text('Chưa có món nào'), findsOneWidget);
      expect(find.byType(NavigationRail), findsOneWidget);

      await tester.tap(find.text('Bàn'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bàn 1'));
      await tester.pumpAndSettle();
      expect(find.text('Bàn trống'), findsOneWidget);

      await tester.tap(find.text('Trà đào cam sả'));
      await tester.pump();
      await tester.tap(find.text('Thêm ghi chú'));
      await tester.pumpAndSettle();
      expect(find.text('Ghi chú món'), findsOneWidget);
      await tester.tap(find.text('ít đá'));
      await tester.pump();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(find.text('ít đá'), findsOneWidget);

      await tester.tap(find.text('Giữ đơn'));
      await tester.pumpAndSettle();
      final create = verify(() => api.post('/pos/hold', captureAny(), any())).captured.single;
      expect(create, {
        'table_id': 1,
        'items': [
          {'product_id': 21, 'quantity': 1, 'note': 'ít đá'},
        ],
      });
      expect(find.text('Đã lưu đơn CF261014-00102 cho bàn.'), findsOneWidget);

      await tester.tap(find.text('Zalo'));
      await tester.pumpAndSettle();
      expect(find.text('Đơn Zalo chờ khách xác nhận'), findsOneWidget);
      expect(find.text('CF261014-00042'), findsOneWidget);
      await tester.tap(find.text('Xem'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cà phê sữa đá', findRichText: true), findsWidgets);

      await tester.tap(find.text('Hủy'));
      await tester.pumpAndSettle();
      expect(find.text('Hủy đơn nháp?'), findsOneWidget);
      await tester.tap(find.text('Hủy đơn nháp'));
      await tester.pumpAndSettle();
      verify(() => api.post('/orders/42/cancel', any())).called(1);
      expect(find.text('Đã hủy đơn CF261014-00042.'), findsOneWidget);
    });

    testWidgets('cashier: INSUFFICIENT_STOCK stays in the pay sheet and the just-created order is cancelled', (tester) async {
      await setSurface(tester, tablet);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((_) async => throw ApiException(
            code: 'INSUFFICIENT_STOCK',
            status: 409,
            message: 'Không đủ tồn kho: Sữa đặc (cần 2, còn 1 hộp)',
          ));

      await tester.pumpWidget(await testApp(const PosScreen(), api: api, user: cashierUser));
      await tester.pumpAndSettle();
      expect(find.text('Đơn hàng'), findsNothing);
      expect(find.text('Quản lý'), findsNothing);
      expect(find.text('Thu Ngân'), findsOneWidget);

      await tester.tap(find.text('Bạc xỉu'));
      await tester.pump();
      await tester.tap(find.text('THANH TOÁN'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Chuyển khoản'));
      await tester.pump();
      expect(find.text('Khách đưa'), findsNothing); // cash only
      await tester.tap(find.text('XÁC NHẬN THANH TOÁN'));
      await tester.pumpAndSettle();

      expect(find.text('Không đủ tồn kho: Sữa đặc (cần 2, còn 1 hộp)'), findsOneWidget);
      final pay = verify(() => api.post('/pos/checkout', captureAny(), any())).captured.single;
      expect(pay, {
        'items': [
          {'product_id': 12, 'quantity': 1},
        ],
        'method': 'transfer',
        'discount': 0,
      });
      verifyNever(() => api.post('/orders/101/cancel', any())); // the server cancels a failed sale itself
      expect(find.text('XÁC NHẬN THANH TOÁN'), findsOneWidget); // sheet still open for another try
      expect(find.text('Đơn mới · 1 món'), findsOneWidget); // cart kept
    });

    testWidgets('/pos?order=55 opens the order; discount is applied in the cart and sent with the payment', (tester) async {
      await setSurface(tester, tablet);
      final api = MockApi();
      stubPosReads(api);
      when(() => api.get('/orders/55', query: any(named: 'query'))).thenAnswer((_) async => order55());
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((_) async => {...orderRes(55, 'completed', 69000), 'change': 0});

      await tester.pumpWidget(await testApp(const PosScreen(orderId: 55), api: api, user: cashierUser));
      await tester.pumpAndSettle();
      expect(find.text('CF261014-00055 · 3 món'), findsOneWidget);
      expect(find.text('Đóng đơn'), findsOneWidget); // cashiers cannot cancel

      await tester.tap(find.text('0đ'));
      await tester.pumpAndSettle();
      expect(find.text('Giảm giá (đ)'), findsOneWidget);
      await tester.enterText(find.byType(TextField).last, '10000');
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(find.text('−10.000đ'), findsOneWidget);
      expect(find.text('69.000đ'), findsOneWidget);

      await tester.tap(find.text('THANH TOÁN'));
      await tester.pumpAndSettle();
      expect(find.text('Bàn 2 · 3 món'), findsOneWidget);
      await tester.tap(find.text('Đủ tiền'));
      await tester.pump();
      await tester.tap(find.text('XÁC NHẬN THANH TOÁN'));
      await tester.pumpAndSettle();

      final pay = verify(() => api.post('/pos/checkout', captureAny(), any())).captured.single;
      expect(pay, {
        'order_id': 55,
        'items': [
          {'product_id': 11, 'quantity': 2, 'note': 'ít đá'},
          {'product_id': 12, 'quantity': 1},
        ],
        'method': 'cash',
        'tendered': 69000,
        'discount': 10000,
      });
      expect(find.text('Đã thanh toán CF261014-00055.'), findsOneWidget);
      expect(find.text('Chọn bàn'), findsOneWidget); // table order paid: back to the table map
    });
  });
}
