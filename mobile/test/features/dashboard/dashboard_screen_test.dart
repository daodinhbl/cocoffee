import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/dashboard/dashboard_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'dashboard_fixtures.dart';

Future<void> pumpDashboard(WidgetTester tester, MockApi api, {Size size = phone, bool router = false}) async {
  await setSurface(tester, size);
  await tester.pumpWidget(router ? await routerTestApp(api) : await testApp(const DashboardScreen(), api: api));
  await tester.pumpAndSettle();
}

void main() {
  group('phone', () {
    testWidgets('renders every section of the web page with the API numbers', (tester) async {
      final api = stubbedApi();
      await pumpDashboard(tester, api);

      // Hero
      expect(find.text('DOANH THU HÔM NAY'), findsOneWidget);
      expect(find.text('1.250.000đ'), findsOneWidget);
      expect(find.text('+25,0% so với hôm qua'), findsOneWidget);
      expect(find.textContaining('23 đơn hoàn tất · cập nhật lúc '), findsOneWidget);
      expect(find.textContaining('Chủ Quán'), findsOneWidget);
      for (final a in ['Mở POS', 'Đơn hàng', 'Báo cáo']) {
        expect(find.text(a), findsOneWidget);
      }

      // KPI cards
      expect(find.text('GIÁ VỐN (COGS)'), findsOneWidget);
      expect(find.text('437.500đ'), findsOneWidget);
      expect(find.text('35,0% doanh thu'), findsOneWidget);
      expect(find.text('LÃI GỘP'), findsOneWidget);
      expect(find.text('812.500đ'), findsOneWidget);
      expect(find.text('65,0% biên lợi nhuận'), findsOneWidget);
      expect(find.text('ĐƠN CHỜ THU'), findsOneWidget);
      expect(find.text('2 đơn Zalo chờ khách xác nhận · 3 đang phục vụ'), findsOneWidget);
      expect(find.text('ĐANG PHỤC VỤ'), findsOneWidget);
      expect(find.text('3 đơn'), findsOneWidget);
      expect(find.text('Xem sơ đồ bàn →'), findsOneWidget);

      // Hourly chart, scrollable on a phone
      expect(find.text('Doanh thu theo giờ'), findsOneWidget);
      expect(find.text('06:00 – 22:00 · hôm nay'), findsOneWidget);
      expect(find.byKey(const ValueKey('hourly-chart')), findsOneWidget);

      // Recent orders as cards (rtable)
      expect(find.text('Đơn gần đây'), findsOneWidget);
      expect(find.text('CF261014-00041'), findsOneWidget);
      expect(find.text('14/10/2026 09:15'), findsOneWidget);
      expect(find.text('Chờ thu tiền'), findsOneWidget);
      expect(find.text('Chờ khách xác nhận'), findsOneWidget);
      expect(find.text('Hoàn tất'), findsOneWidget);
      expect(find.text('Đã hủy'), findsOneWidget);
      expect(find.text('KÊNH'), findsNWidgets(5));
      expect(find.text('MÃ ĐƠN'), findsNothing);

      // Low stock: list + "Hàng sắp hết" ranking
      expect(find.text('Cảnh báo tồn kho thấp'), findsOneWidget);
      expect(find.text('2 mục'), findsOneWidget);
      expect(find.text('800 / 2.000 ml'), findsOneWidget);
      expect(find.text('Sữa tươi'), findsNWidgets(2));

      // Phân tích nhanh
      expect(find.text('Phân tích nhanh'), findsOneWidget);
      expect(find.text('Món bán chạy'), findsOneWidget);
      expect(find.text('132 món'), findsOneWidget);
      expect(find.text('Hàng sắp hết'), findsOneWidget);
      expect(find.text('40%'), findsOneWidget);
      expect(find.text('Nguy cấp'), findsOneWidget);
      expect(find.text('75%'), findsOneWidget);
      expect(find.text('Sắp hết'), findsOneWidget);
      expect(find.text('Nguyên liệu tồn kho nhiều'), findsOneWidget);
      expect(find.text('550.000đ'), findsOneWidget);
      expect(find.text('Khách hàng công nợ nhiều nhất'), findsOneWidget);
      expect(find.text('Chị Lan'), findsOneWidget);
      expect(find.text('Khách Zalo …5678'), findsOneWidget);
      expect(find.text('255.000đ'), findsOneWidget);

      // Header: Zalo dot on phones, bell with the count
      expect(find.byKey(const ValueKey('zalo-dot')), findsOneWidget);
      expect(find.byKey(const ValueKey('zalo-pill')), findsNothing);
      expect(find.byTooltip('Thông báo (5)'), findsOneWidget);
      expect(find.text('5'), findsOneWidget);

      verify(() => api.get('/admin/dashboard', query: any(named: 'query'))).called(1);
      verify(() => api.get('/zalo/status', query: any(named: 'query'))).called(1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('tapping an hour bar shows its tooltip', (tester) async {
      await pumpDashboard(tester, stubbedApi());
      final chart = find.byKey(const ValueKey('hourly-chart'));
      await tester.ensureVisible(chart);
      await tester.pumpAndSettle();
      // 17 slots over 560 dp: hour 09 is the 4th slot.
      final topLeft = tester.getTopLeft(chart);
      await tester.tapAt(topLeft + const Offset(560 / 17 * 3.5, 120));
      await tester.pump();
      expect(find.text('09:00 · 125.000đ · 4 đơn'), findsOneWidget);
    });

    testWidgets('pull to refresh reloads the dashboard, the bell and the Zalo state', (tester) async {
      final api = stubbedApi();
      await pumpDashboard(tester, api);
      await tester.fling(find.byKey(const ValueKey('hero-revenue')), const Offset(0, 500), 1200);
      await tester.pumpAndSettle();
      verify(() => api.get('/admin/dashboard', query: any(named: 'query'))).called(2);
      verify(() => api.get('/admin/notifications', query: any(named: 'query'))).called(2);
      verify(() => api.get('/zalo/status', query: any(named: 'query'))).called(2);
    });

    testWidgets('empty day: web empty states and "Hôm qua chưa có doanh thu"', (tester) async {
      await pumpDashboard(tester, stubbedApi(dashboard: emptyDashboardJson(), notifications: emptyNotificationsJson()));
      expect(find.text('Hôm qua chưa có doanh thu'), findsOneWidget);
      expect(find.text('Chưa có đơn hoàn tất'), findsOneWidget);
      expect(find.text('—'), findsOneWidget);
      expect(find.text('0 đơn'), findsOneWidget);
      expect(find.text('Chưa có đơn hàng nào.'), findsOneWidget);
      expect(find.text('Mọi nguyên liệu đều trên mức tối thiểu.'), findsOneWidget);
      expect(find.textContaining('mục'), findsNothing);
      expect(find.text('Chưa có đơn hoàn tất trong 30 ngày.'), findsOneWidget);
      expect(find.text('Không có nguyên liệu nào dưới mức tối thiểu.'), findsOneWidget);
      expect(find.text('Chưa có giá trị tồn kho.'), findsOneWidget);
      expect(find.text('Không có khách nào đang nợ.'), findsOneWidget);
      expect(find.byTooltip('Thông báo (0)'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('notif-bell')));
      await tester.pumpAndSettle();
      expect(find.text('Không có thông báo mới.'), findsOneWidget);
    });

    testWidgets('server error shows the Vietnamese message and "Thử lại" reloads', (tester) async {
      final api = stubbedApi();
      when(() => api.get('/admin/dashboard', query: any(named: 'query')))
          .thenThrow(ApiException(code: 'INTERNAL', status: 500, message: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.'));
      await pumpDashboard(tester, api);
      expect(find.text('Máy chủ gặp lỗi. Vui lòng thử lại sau.'), findsOneWidget);

      when(() => api.get('/admin/dashboard', query: any(named: 'query'))).thenAnswer((_) async => dashboardJson());
      await tester.tap(find.text('Thử lại'));
      await tester.pumpAndSettle();
      expect(find.text('1.250.000đ'), findsOneWidget);
    });

    testWidgets('cashier: shortcuts only, no admin endpoints, no bell', (tester) async {
      final api = stubbedApi();
      await setSurface(tester, phone);
      await tester.pumpWidget(await testApp(const DashboardScreen(), api: api, user: cashierUser));
      await tester.pumpAndSettle();
      expect(find.text('Tổng quan doanh thu chỉ dành cho quản trị viên.'), findsOneWidget);
      expect(find.text('Mở POS'), findsOneWidget);
      expect(find.text('Bàn'), findsOneWidget);
      expect(find.byKey(const ValueKey('notif-bell')), findsNothing);
      verifyNever(() => api.get('/admin/dashboard', query: any(named: 'query')));
      verifyNever(() => api.get('/admin/notifications', query: any(named: 'query')));
    });

    testWidgets('narrow phone (360 dp), long names and big numbers: no overflow', (tester) async {
      final j = dashboardJson();
      (j['today'] as Map)['revenue'] = 123456789000;
      (j['best_sellers'] as List).add({'product_id': 9, 'product_name': 'Trà sữa trân châu hoàng kim kem phô mai size lớn', 'qty': 12345, 'revenue': 987654321});
      (j['low_stock'] as List).add({'id': 11, 'name': 'Siro caramel muối Hàn Quốc chai thủy tinh 750ml', 'unit': 'chai', 'quantity_on_hand': 0, 'min_stock': 12, 'ratio': 0});
      (j['recent_orders'] as List).first['order_code'] = 'CF261014-00041-ZALO-NHOM';
      await pumpDashboard(tester, stubbedApi(dashboard: j), size: const Size(360, 740));
      expect(find.text('Trà sữa trân châu hoàng kim kem phô mai size lớn'), findsOneWidget);
      expect(find.text('0%'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('navigation', () {
    testWidgets('bell sheet lists the notifications in the web order; a failed bill opens the order', (tester) async {
      final api = stubbedApi();
      await pumpDashboard(tester, api, router: true);

      await tester.tap(find.byKey(const ValueKey('notif-bell')));
      await tester.pumpAndSettle();
      expect(find.text('Thông báo'), findsOneWidget);
      final texts = [
        'Bill Zalo gửi lỗi — CF261014-00041',
        '2 đơn Zalo chờ khách xác nhận',
        '4 đơn chờ thu tiền',
        'Sữa tươi dưới mức tồn tối thiểu',
        'Cà phê hạt dưới mức tồn tối thiểu',
      ];
      for (final t in texts) {
        expect(find.text(t), findsOneWidget);
      }
      final ys = [for (final t in texts) tester.getTopLeft(find.text(t)).dy];
      expect(ys, orderedEquals([...ys]..sort()));

      await tester.tap(find.text('Bill Zalo gửi lỗi — CF261014-00041'));
      await tester.pumpAndSettle();
      expect(find.text('route /orders/41'), findsOneWidget);
    });

    testWidgets('bell: drafts go to the filtered orders list, low stock to the item page', (tester) async {
      await pumpDashboard(tester, stubbedApi(), router: true);
      await tester.tap(find.byKey(const ValueKey('notif-bell')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('2 đơn Zalo chờ khách xác nhận'));
      await tester.pumpAndSettle();
      expect(find.text('route /orders?status=draft'), findsOneWidget);
    });

    testWidgets('bell: a low-stock row pushes the inventory item', (tester) async {
      await pumpDashboard(tester, stubbedApi(), router: true);
      await tester.tap(find.byKey(const ValueKey('notif-bell')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sữa tươi dưới mức tồn tối thiểu'));
      await tester.pumpAndSettle();
      expect(find.text('route /inventory/3'), findsOneWidget);
    });

    testWidgets('a recent order card opens the order; a low-stock row opens receiving', (tester) async {
      await pumpDashboard(tester, stubbedApi(), router: true);
      final card = find.text('CF261014-00040');
      await tester.ensureVisible(card);
      await tester.pumpAndSettle();
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(find.text('route /orders/40'), findsOneWidget);
    });

    testWidgets('a low-stock row opens receiving for that item', (tester) async {
      await pumpDashboard(tester, stubbedApi(), router: true);
      final row = find.text('800 / 2.000 ml');
      await tester.ensureVisible(row);
      await tester.pumpAndSettle();
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.text('route /receiving?item=3'), findsOneWidget);
    });

    testWidgets('hero "Mở POS" pushes the POS', (tester) async {
      await pumpDashboard(tester, stubbedApi(), router: true);
      await tester.tap(find.text('Mở POS'));
      await tester.pumpAndSettle();
      expect(find.text('route /pos'), findsOneWidget);
    });
  });

  group('tablet', () {
    testWidgets('wide layout: Zalo pill, 4 KPI columns, orders as a table, charts in 2 columns', (tester) async {
      final api = stubbedApi(zalo: {'state': 'warn', 'label': 'Zalo bot: chưa nhận tin'});
      await pumpDashboard(tester, api, size: tablet);

      expect(find.byKey(const ValueKey('zalo-pill')), findsOneWidget);
      expect(find.text('Zalo bot: chưa nhận tin'), findsOneWidget);

      // 4 KPI cards on one row
      final y = tester.getTopLeft(find.text('GIÁ VỐN (COGS)')).dy;
      for (final l in ['LÃI GỘP', 'ĐƠN CHỜ THU', 'ĐANG PHỤC VỤ']) {
        expect(tester.getTopLeft(find.text(l)).dy, moreOrLessEquals(y, epsilon: 1));
      }

      // Recent orders as a real table beside the low-stock card
      expect(find.text('MÃ ĐƠN'), findsOneWidget);
      expect(find.text('TỔNG TIỀN'), findsOneWidget);
      expect(find.text('KÊNH'), findsOneWidget);
      final recentX = tester.getTopLeft(find.text('Đơn gần đây')).dx;
      final lowX = tester.getTopLeft(find.text('Cảnh báo tồn kho thấp')).dx;
      expect(lowX, greaterThan(recentX + 300));
      expect(tester.getTopLeft(find.text('Cảnh báo tồn kho thấp')).dy,
          moreOrLessEquals(tester.getTopLeft(find.text('Đơn gần đây')).dy, epsilon: 1));

      // Charts two by two
      expect(tester.getTopLeft(find.text('Hàng sắp hết')).dy,
          moreOrLessEquals(tester.getTopLeft(find.text('Món bán chạy')).dy, epsilon: 1));

      // Hero shows the 48 dp quick actions in a row next to the revenue
      expect(tester.getTopLeft(find.text('Báo cáo')).dy, moreOrLessEquals(tester.getTopLeft(find.text('Mở POS')).dy, epsilon: 1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('wide layout: a table row opens the order', (tester) async {
      await setSurface(tester, tablet);
      await tester.pumpWidget(await routerTestApp(stubbedApi()));
      await tester.pumpAndSettle();
      final row = find.text('CF261014-00039');
      await tester.ensureVisible(row);
      await tester.pumpAndSettle();
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.text('route /orders/39'), findsOneWidget);
    });
  });
}
