import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/widgets/common.dart';
import 'package:cocoffee_mobile/features/reports/report_bar_chart.dart';
import 'package:cocoffee_mobile/features/reports/reports_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'report_fixtures.dart';

void main() {
  late MockApi api;

  /// Answers like the server: the asked range, or the default week when no range is sent.
  void stubReports({bool clamped = false, bool empty = false}) {
    when(() => api.get('/admin/reports', query: any(named: 'query'))).thenAnswer((inv) async {
      final q = inv.namedArguments[#query] as Map<String, dynamic>?;
      final from = q?['from'] as String? ?? '2026-10-08';
      final to = q?['to'] as String? ?? '2026-10-14';
      return reportJson(from: from, to: to, clamped: clamped, empty: empty);
    });
  }

  Future<void> pumpReports(WidgetTester tester, Size size) async {
    await setSurface(tester, size);
    await tester.pumpWidget(await testApp(const ReportsScreen(), api: api));
    await tester.pumpAndSettle();
  }

  Finder outerList() => find.byType(Scrollable).first;

  Future<void> scrollTo(WidgetTester tester, Finder f) async {
    await tester.scrollUntilVisible(f, 250, scrollable: outerList());
    await tester.pumpAndSettle();
  }

  setUp(() {
    api = MockApi();
  });

  testWidgets('phone: every section of the web report in order, numbers formatted like the web', (tester) async {
    stubReports();
    await pumpReports(tester, phone);

    // first load lets the server pick its default range (7 ngày)
    verify(() => api.get('/admin/reports', query: {'from': null, 'to': null})).called(1);

    expect(find.text('Báo cáo'), findsOneWidget);
    expect(find.textContaining('Đơn đã hoàn tất · 08/10/2026 – 14/10/2026.'), findsOneWidget);
    expect(find.textContaining('Khoảng thời gian tối đa'), findsNothing);
    for (final label in ['Hôm nay', 'Hôm qua', '7 ngày', 'Tháng này', 'Tháng trước', 'Từ ngày', 'Đến ngày', 'Xem']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(find.text('08/10/2026'), findsOneWidget);
    expect(find.text('14/10/2026'), findsOneWidget);

    // KPI cards: 2 columns on phones
    expect(find.text('11.510.000đ'), findsOneWidget);
    expect(find.text('262 đơn · TB 43.931đ/đơn'), findsOneWidget);
    expect(find.text('3.813.000đ'), findsOneWidget);
    expect(find.text('33,1% doanh thu'), findsOneWidget);
    expect(find.text('7.697.000đ'), findsOneWidget);
    expect(find.text('66,9% biên lợi nhuận'), findsOneWidget);
    expect(find.text('Đơn Zalo đã hoàn tất, chờ thu'), findsOneWidget);
    final revenueTile = tester.getTopLeft(find.text('DOANH THU').first);
    final cogsTile = tester.getTopLeft(find.text('GIÁ VỐN (COGS)'));
    final profitTile = tester.getTopLeft(find.text('LÃI GỘP').first);
    expect(cogsTile.dy, revenueTile.dy);
    expect(profitTile.dy, greaterThan(revenueTile.dy));

    // Doanh thu theo ngày: chart + table (no bar column on phones), empty day listed too
    await scrollTo(tester, find.text('Doanh thu theo ngày'));
    expect(find.byKey(const Key('day-chart')), findsOneWidget);
    await scrollTo(tester, find.text('2.735.000đ'));
    expect(find.text('12/10'), findsOneWidget);
    expect(find.text('1.830.000đ'), findsOneWidget); // lãi gộp = 2.735.000 − 905.000
    expect(find.text('10/10'), findsOneWidget);
    expect(find.byType(FractionallySizedBox), findsNothing);

    await scrollTo(tester, find.text('Món bán chạy (theo doanh thu)'));
    await scrollTo(tester, find.text('Sinh tố bơ'));
    expect(find.text('Cà phê sữa đá'), findsOneWidget);
    expect(find.text('96 ly/phần · lãi gộp 2.073.600đ (72,0%)'), findsOneWidget);
    expect(find.text('2.880.000đ'), findsOneWidget);

    await scrollTo(tester, find.text('Theo giờ trong ngày'));
    expect(find.byKey(const Key('hour-chart')), findsOneWidget);

    await scrollTo(tester, find.text('Kênh bán & thanh toán'));
    await scrollTo(tester, find.textContaining('Chưa thu'));
    expect(find.text('KÊNH'), findsOneWidget);
    expect(find.text('THANH TOÁN'), findsOneWidget);
    expect(find.text('POS · 214 đơn · 79,8%'), findsOneWidget);
    expect(find.text('Zalo · 48 đơn · 20,2%'), findsOneWidget);
    expect(find.text('Tiền mặt · 151 đơn'), findsOneWidget);
    expect(find.text('Chuyển khoản · 97 đơn'), findsOneWidget);
    expect(find.text('Chưa thu · 14 đơn'), findsOneWidget);
    expect(find.text('9.180.000đ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('phone: tapping a day bar shows its value', (tester) async {
    stubReports();
    await pumpReports(tester, phone);
    final plot = find.descendant(of: find.byKey(const Key('day-chart')), matching: find.byKey(ReportBarChart.plotKey));
    await tester.ensureVisible(plot);
    await tester.pumpAndSettle();

    final rect = tester.getRect(plot);
    final slot = rect.width / 7;
    await tester.tapAt(Offset(rect.left + slot * 4.5, rect.top + rect.height * 0.6)); // 12/10
    await tester.pump();
    expect(find.text('12/10: 2.735.000đ · 61 đơn'), findsOneWidget);

    // tap the same bar again to hide the tooltip
    await tester.tapAt(Offset(rect.left + slot * 4.5, rect.top + rect.height * 0.6));
    await tester.pump();
    expect(find.text('12/10: 2.735.000đ · 61 đơn'), findsNothing);
  });

  testWidgets('phone: a preset chip reloads the report for that range', (tester) async {
    stubReports();
    await pumpReports(tester, phone);

    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();

    verify(() => api.get('/admin/reports', query: {'from': '2026-10-13', 'to': '2026-10-13'})).called(1);
    expect(find.textContaining('Đơn đã hoàn tất · 13/10/2026.'), findsOneWidget);
    expect(find.text('2.010.000đ'), findsWidgets);
    expect(find.text('47 đơn · TB 42.766đ/đơn'), findsOneWidget);
    // the form follows the shown range
    expect(find.text('13/10/2026'), findsNWidgets(2));
  });

  testWidgets('phone: custom range from the date picker, then "Xem"', (tester) async {
    stubReports();
    await pumpReports(tester, phone);

    await tester.tap(find.byKey(const Key('report-from')));
    await tester.pumpAndSettle();
    expect(find.byType(DatePickerDialog), findsOneWidget);
    await tester.tap(find.descendant(of: find.byType(DatePickerDialog), matching: find.text('1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chọn'));
    await tester.pumpAndSettle();
    expect(find.text('01/10/2026'), findsOneWidget);

    await tester.tap(find.text('Xem'));
    await tester.pumpAndSettle();

    verify(() => api.get('/admin/reports', query: {'from': '2026-10-01', 'to': '2026-10-14'})).called(1);
    expect(find.textContaining('Đơn đã hoàn tất · 01/10/2026 – 14/10/2026.'), findsOneWidget);
  });

  testWidgets('tablet: xl layout (4 KPI columns, 7/5 cards, bar column) and the hour tooltip', (tester) async {
    stubReports();
    await pumpReports(tester, tablet);

    final kpiY = tester.getTopLeft(find.text('GIÁ VỐN (COGS)')).dy;
    expect(tester.getTopLeft(find.text('CHƯA THU TIỀN')).dy, kpiY);
    expect(tester.getTopLeft(find.text('Món bán chạy (theo doanh thu)')).dy, tester.getTopLeft(find.text('Doanh thu theo ngày')).dy);
    expect(tester.getTopLeft(find.text('Món bán chạy (theo doanh thu)')).dx,
        greaterThan(tester.getTopLeft(find.text('Doanh thu theo ngày')).dx));
    expect(find.byType(FractionallySizedBox), findsNWidgets(7)); // inline revenue bars in the day table

    await scrollTo(tester, find.byKey(const Key('hour-chart')));
    final plot = find.descendant(of: find.byKey(const Key('hour-chart')), matching: find.byKey(ReportBarChart.plotKey));
    await tester.ensureVisible(plot);
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(find.text('Kênh bán & thanh toán')).dy, tester.getTopLeft(find.text('Theo giờ trong ngày')).dy);

    final rect = tester.getRect(plot);
    final slot = rect.width / 24;
    await tester.tapAt(Offset(rect.left + slot * 8.5, rect.bottom - 30));
    await tester.pump();
    expect(find.text('8h: 2.170.000đ · 44 đơn'), findsOneWidget);

    await tester.tapAt(Offset(rect.left + slot * 2.5, rect.bottom - 30));
    await tester.pump();
    expect(find.text('8h: 2.170.000đ · 44 đơn'), findsNothing);
    expect(find.text('2h: 0đ · 0 đơn'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tablet: clamped range shows the amber notice', (tester) async {
    stubReports(clamped: true);
    await pumpReports(tester, tablet);
    expect(find.text('Khoảng thời gian tối đa là 366 ngày; đang hiển thị 7 ngày gần nhất.'), findsOneWidget);
  });

  testWidgets('phone: a range without completed orders shows the web empty states', (tester) async {
    stubReports(empty: true);
    await pumpReports(tester, phone);

    expect(find.text('0 đơn · TB 0đ/đơn'), findsOneWidget);
    Finder dashIn(Finder card) => find.descendant(of: card, matching: find.text('—'));
    // COGS share and margin have no base without revenue
    expect(dashIn(find.ancestor(of: find.text('GIÁ VỐN (COGS)'), matching: find.byType(Card))), findsOneWidget);
    expect(dashIn(find.ancestor(of: find.text('LÃI GỘP'), matching: find.byType(Card))), findsOneWidget);
    expect(find.text('Không có đơn hoàn tất trong khoảng này.'), findsOneWidget);
    expect(find.byKey(const Key('day-chart')), findsNothing);
    await scrollTo(tester, find.text('Chưa có dữ liệu.'));
    expect(find.byKey(const Key('hour-chart')), findsOneWidget);
    await scrollTo(tester, find.text('THANH TOÁN'));
    // empty channel and payment lists
    expect(dashIn(find.ancestor(of: find.text('Kênh bán & thanh toán'), matching: find.byType(SectionCard))), findsNWidgets(2));
  });

  testWidgets('error: Vietnamese message and "Thử lại" reloads', (tester) async {
    var calls = 0;
    when(() => api.get('/admin/reports', query: any(named: 'query'))).thenAnswer((_) async {
      calls++;
      if (calls == 1) throw ApiException(code: 'INTERNAL', status: 500, message: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.');
      return reportJson();
    });
    await pumpReports(tester, phone);

    expect(find.text('Máy chủ gặp lỗi. Vui lòng thử lại sau.'), findsOneWidget);
    await tester.tap(find.text('Thử lại'));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.text('11.510.000đ'), findsOneWidget);
  });
}
