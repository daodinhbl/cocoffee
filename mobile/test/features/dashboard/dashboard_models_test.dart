import 'package:cocoffee_mobile/core/widgets/common.dart';
import 'package:cocoffee_mobile/features/dashboard/dashboard_models.dart';
import 'package:cocoffee_mobile/features/dashboard/widgets/hourly_chart.dart';
import 'package:flutter_test/flutter_test.dart';

import 'dashboard_fixtures.dart';

void main() {
  test('parses GET /api/admin/dashboard, numbers given as numbers or strings', () {
    final d = DashboardData.fromJson(dashboardJson());
    expect(d.today.revenue, 1250000);
    expect(d.yesterday.revenue, 1000000);
    expect(d.margin, 65);
    expect(d.counts.drafts, 2);
    expect(d.counts.openOrders, 3);
    expect(d.counts.unpaid, 4);
    expect(d.recentOrders.first.statusLabel, ('Chờ thu tiền', Tone.warn));
    expect(d.recentOrders.first.sourceBadge, ('Zalo', Tone.info));
    expect(d.hourly.length, 17);
    expect(d.lowStock.map((i) => i.name), ['Sữa tươi', 'Cà phê hạt']);
    expect(d.lowStock.first.barPercent, 40);

    final s = DashboardData.fromJson({
      'today': {'orders': '3', 'revenue': '150000.00', 'cogs': '52500.00', 'gross_profit': '97500.00', 'unpaid': '0'},
      'yesterday': {'revenue': null},
      'counts': {'drafts': '1', 'open_orders': '0', 'unpaid': '2'},
      'hourly': [
        {'hour': '9', 'revenue': '150000.00', 'orders': '3'},
      ],
      'low_stock': [
        {'id': '4', 'name': 'Đá viên', 'unit': 'kg', 'quantity_on_hand': '1.500', 'min_stock': '5.000'},
      ],
    });
    expect(s.today.orders, 3);
    expect(s.today.revenue, 150000);
    expect(s.margin, 65); // computed when the server omits it
    expect(s.counts.unpaid, 2);
    expect(s.hourly.length, 17);
    expect(s.hourly.firstWhere((h) => h.hour == 9).revenue, 150000);
    expect(s.hourly.first.hour, 6);
    expect(s.hourly.last.hour, 22);
    expect(s.lowStock.single.ratio, closeTo(0.3, 1e-9));
    expect(s.recentOrders, isEmpty);
    expect(s.debtors, isEmpty);
  });

  test('revenueDelta matches the web wording', () {
    expect(revenueDelta(1250000, 1000000), ('+25,0% so với hôm qua', Tone.good));
    expect(revenueDelta(900000, 1000000), ('−10,0% so với hôm qua', Tone.warn));
    expect(revenueDelta(500000, 0), ('Hôm qua chưa có doanh thu', Tone.neutral));
  });

  test('greeting by shop hour and the vi-VN long date at UTC+7', () {
    expect(greeting(6), 'Chào buổi sáng');
    expect(greeting(11), 'Chào buổi trưa');
    expect(greeting(14), 'Chào buổi chiều');
    expect(greeting(18), 'Chào buổi tối');
    expect(longShopDate(DateTime.utc(2026, 10, 14, 3)), 'Thứ Tư, 14/10/2026');
    // 18:30 UTC on Tuesday the 13th is 01:30 on Wednesday the 14th in the shop.
    expect(longShopDate(DateTime.utc(2026, 10, 13, 18, 30)), 'Thứ Tư, 14/10/2026');
    expect(longShopDate(DateTime.utc(2026, 10, 18, 2)), 'Chủ Nhật, 18/10/2026');
  });

  test('debtor name falls back to the Zalo id', () {
    final d = DashboardData.fromJson(dashboardJson()).debtors;
    expect(d[0].who, 'Chị Lan');
    expect(d[1].who, 'Khách Zalo …5678');
  });

  test('hour tooltip text', () {
    expect(hourTooltip(const HourSales(hour: 9, revenue: 125000, orders: 4)), '09:00 · 125.000đ · 4 đơn');
  });

  test('bell rows: web order, caps of 3 failed bills and 5 low-stock items, app deep links', () {
    final n = NotificationsData.fromJson({
      'low_stock': [
        for (var i = 1; i <= 7; i++) {'id': i, 'name': 'NL $i', 'unit': 'g', 'quantity_on_hand': 1, 'min_stock': 10},
      ],
      'counts': {'drafts': 2, 'open_orders': 3, 'unpaid': 4},
      'receipt_errors': [
        for (var i = 1; i <= 4; i++) {'id': 100 + i, 'order_code': 'CF$i', 'receipt_error': 'x', 'completed_at': '2026-10-14T02:00:00Z'},
      ],
    });
    final rows = buildNotes(n, now: DateTime.utc(2026, 10, 14, 2, 30));
    expect(rows.length, 3 + 1 + 1 + 5);
    expect(rows[0].text, 'Bill Zalo gửi lỗi — CF1');
    expect(rows[0].time, '30 phút trước');
    expect(rows[0].tone, Tone.bad);
    expect(rows[0].location, '/orders/101');
    expect(rows[0].target, NoteTarget.push);
    expect(rows[3].text, '2 đơn Zalo chờ khách xác nhận');
    expect(rows[3].tone, Tone.info);
    expect(rows[3].target, NoteTarget.go);
    expect(rows[4].text, '4 đơn chờ thu tiền');
    expect(rows[4].location, '/orders?status=completed&payment=unpaid');
    expect(rows[5].text, 'NL 1 dưới mức tồn tối thiểu');
    expect(rows[5].location, '/inventory/1');
    expect(rows.last.text, 'NL 5 dưới mức tồn tối thiểu');

    expect(buildNotes(NotificationsData.fromJson(emptyNotificationsJson())), isEmpty);
  });

  test('Zalo status: unknown states fall back to grey', () {
    expect(ZaloStatus.fromJson({'state': 'ok', 'label': 'Zalo bot OK'}).state, 'ok');
    final z = ZaloStatus.fromJson({'state': 'weird'});
    expect(z.state, 'unknown');
    expect(z.label, 'Zalo: không rõ');
  });
}
