import 'package:cocoffee_mobile/features/inventory/inventory_detail_screen.dart';
import 'package:cocoffee_mobile/features/inventory/inventory_screen.dart';
import 'package:cocoffee_mobile/features/inventory/receiving_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'inventory_fixtures.dart';
import '../../helpers/test_app.dart';

void main() {
  for (final size in const [Size(360, 740), Size(700, 1000), Size(1032, 800)]) {
    testWidgets('list, item page and receiving lay out without overflow at $size (scrolled to the end)', (tester) async {
      final api = MockApi();
      when(() => api.get('/inventory', query: any(named: 'query'))).thenAnswer((inv) async =>
          (inv.namedArguments[#query] as Map?)?['all'] == '1' ? inventoryAllResponse() : inventoryActiveResponse());
      when(() => api.get('/inventory/1', query: any(named: 'query'))).thenAnswer((_) async => inventoryDetailResponse());
      when(() => api.get('/inventory/purchases', query: any(named: 'query'))).thenAnswer((_) async => purchasesResponse());
      await setSurface(tester, size);
      for (final w in [const InventoryScreen(), const InventoryDetailScreen(id: 1), const ReceivingScreen(itemId: 1)]) {
        await tester.pumpWidget(await testApp(w, api: api));
        await tester.pumpAndSettle();
        final s = find.byType(Scrollable).first;
        for (var i = 0; i < 8; i++) {
          await tester.drag(s, const Offset(0, -400));
          await tester.pumpAndSettle();
        }
      }
    });
  }
}
