import 'package:cocoffee_mobile/features/customers/debt_reconciliation_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'customer_fixtures.dart';

void main() {
  late MockApi api;
  late List<Map<String, dynamic>?> queries;

  setUp(() {
    api = MockApi();
    queries = [];
    when(() => api.get('/admin/customers/reconciliation', query: any(named: 'query'))).thenAnswer((inv) async {
      final q = inv.namedArguments[#query] as Map<String, dynamic>?;
      queries.add(q);
      final from = q?['from'] as String?;
      final to = q?['to'] as String?;
      if (from == null || to == null) return reconciliationJson();
      return reconciliationJson(from: from, to: to, empty: from == '2026-09-01');
    });
  });

  testWidgets('phone: period, presets, totals strip and customer cards', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const DebtReconciliationScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Đối chiếu công nợ'), findsOneWidget);
    expect(find.textContaining('01/10/2026 – 14/10/2026'), findsOneWidget);
    expect(find.text('01/10/2026'), findsOneWidget); // from field
    expect(find.text('14/10/2026'), findsOneWidget); // to field
    expect(find.text('Kỳ nhanh:'), findsOneWidget);
    expect(find.text('Tháng này'), findsOneWidget);
    expect(find.text('Tháng trước'), findsOneWidget);
    expect(find.text('Năm nay'), findsOneWidget);
    expect(find.text('110.000đ'), findsOneWidget); // Nợ đầu kỳ total
    expect(find.text('+120.000đ', skipOffstage: false), findsNWidgets(2)); // total + Nguyễn Văn An
    expect(find.text('−80.000đ', skipOffstage: false), findsOneWidget); // third card of the swipe strip
    expect(find.text('Nguyễn Văn An'), findsOneWidget);
    expect(find.text('Biên bản'), findsWidgets);
    await tester.scrollUntilVisible(find.text('Lê Minh Châu'), 200,
        scrollable: find.descendant(of: find.byType(RefreshIndicator), matching: find.byType(Scrollable)).first);
    expect(find.text('—'), findsOneWidget); // Lê Minh Châu had no increase
    expect(find.text('Tổng cộng (2 khách)'), findsNothing); // footer is desktop only
    expect(tester.takeException(), isNull);
    expect(queries.single, {'from': null, 'to': null, 'q': null});
  });

  testWidgets('phone: "Tháng trước" preset re-queries that period; search + Xem sends q', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const DebtReconciliationScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Tháng trước'));
    await tester.pumpAndSettle();
    expect(queries.last, {'from': '2026-09-01', 'to': '2026-09-30', 'q': null});
    expect(find.textContaining('01/09/2026 – 30/09/2026'), findsOneWidget);
    expect(find.text('Không có khách nào phát sinh công nợ trong kỳ này.'), findsOneWidget);

    await tester.tap(find.text('Tháng này'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'An');
    await tester.tap(find.text('Xem'));
    await tester.pumpAndSettle();
    expect(queries.last, {'from': '2026-10-01', 'to': '2026-10-14', 'q': 'An'});
  });

  testWidgets('tablet: table with headers and the Tổng cộng footer', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const DebtReconciliationScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('KHÁCH HÀNG'), findsOneWidget);
    expect(find.text('NỢ ĐẦU KỲ'), findsNWidgets(2)); // totals card + column header
    expect(find.text('NỢ CUỐI KỲ'), findsNWidgets(2));
    expect(find.text('Tổng cộng (2 khách)'), findsOneWidget);
    expect(find.text('Biên bản'), findsNWidgets(2));
    expect(find.textContaining('Nợ cuối kỳ = Nợ đầu kỳ + Phát sinh tăng'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
