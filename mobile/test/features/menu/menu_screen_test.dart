import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/menu/form_sheet.dart';
import 'package:cocoffee_mobile/features/menu/menu_models.dart';
import 'package:cocoffee_mobile/features/menu/menu_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

Map<String, dynamic> adminMenu() => {
      'products': [
        {
          'id': 1, 'category_id': 1, 'category_name': 'Cà phê', 'sku': 'CF-SUA', 'name': 'Cà phê sữa', 'price': 25000,
          'stock_mode': 'bom', 'inventory_item_id': null, 'inventory_item_name': null, 'is_active': 1, 'image_url': null,
          'aliases': ['Cà phê sữa', 'cf sữa', 'ca phe sua'],
        },
        {
          'id': 2, 'category_id': 1, 'category_name': 'Cà phê', 'sku': 'BAC-XIU', 'name': 'Bạc xỉu', 'price': 29000,
          'stock_mode': 'bom', 'inventory_item_id': null, 'inventory_item_name': null, 'is_active': 1, 'image_url': null,
          'aliases': ['Bạc xỉu'],
        },
        {
          'id': 3, 'category_id': 2, 'category_name': 'Hàng đóng chai', 'sku': 'NUOC-SUOI', 'name': 'Nước suối Aquafina',
          'price': 10000, 'stock_mode': 'direct', 'inventory_item_id': 7, 'inventory_item_name': 'Aquafina 500ml', 'is_active': 0,
          'image_url': '/media/3-aquafina.jpg', 'aliases': ['Nước suối Aquafina', 'nuoc suoi'],
        },
      ],
      'categories': [
        {'id': 1, 'code': 'coffee', 'name': 'Cà phê', 'sort_order': 1, 'is_active': 1},
        {'id': 2, 'code': 'bottled', 'name': 'Hàng đóng chai', 'sort_order': 5, 'is_active': 1},
        {'id': 3, 'code': 'seasonal', 'name': 'Món mùa', 'sort_order': 9, 'is_active': 0},
      ],
      'items': [
        {'id': 7, 'sku': 'AQUA', 'name': 'Aquafina 500ml', 'unit': 'chai', 'is_active': 1},
        {'id': 8, 'sku': 'JET', 'name': 'Thuốc lá Jet', 'unit': 'gói', 'is_active': 1},
      ],
    };

/// TextFormField under the LabeledField with this label.
Finder field(String label) =>
    find.descendant(of: find.widgetWithText(LabeledField, label), matching: find.byType(TextFormField));

Future<void> tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/admin/menu', query: any(named: 'query'))).thenAnswer((_) async => adminMenu());
    when(() => api.put(any(), any())).thenAnswer((_) async => {'product': <String, dynamic>{}});
    when(() => api.post(any(), any())).thenAnswer((_) async => {'id': 9});
  });

  testWidgets('admin phone: chips, product cards, badges and stock mode like menu.ejs', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Thực đơn'), findsOneWidget);
    expect(find.text('+ Nhóm món'), findsOneWidget);
    expect(find.text('+ Hàng bán lẻ'), findsOneWidget);
    expect(find.text('NHÓM MÓN'), findsOneWidget);
    expect(find.text('#1'), findsOneWidget);
    expect(find.text('#9'), findsOneWidget);
    expect(find.text('(ẩn)'), findsOneWidget);
    expect(find.text('MÓN (3)'), findsOneWidget);
    expect(find.text('Cà phê sữa'), findsOneWidget);
    expect(find.text('CF-SUA · cf sữa, ca phe sua', findRichText: true), findsOneWidget);
    expect(find.text('Pha chế (BOM)'), findsNWidgets(2));
    expect(find.text('Bán lẻ'), findsOneWidget);
    expect(find.text('Aquafina 500ml'), findsOneWidget);
    expect(find.text('25.000đ'), findsOneWidget);
    expect(find.text('Đang bán'), findsNWidgets(2));
    expect(find.text('Ngừng bán'), findsOneWidget);
    expect(find.text('Công thức'), findsNWidgets(2));
    expect(find.byType(Switch), findsNWidgets(3));
    expect(find.text('TRỪ KHO'), findsNWidgets(3)); // card field labels
  });

  testWidgets('tablet: products as a table with the web columns', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    for (final h in ['MÓN', 'NHÓM', 'TRỪ KHO', 'GIÁ BÁN', 'TRẠNG THÁI']) {
      expect(find.text(h), findsOneWidget, reason: h);
    }
    expect(find.text('Nước suối Aquafina'), findsOneWidget);
    expect(find.text('10.000đ'), findsOneWidget);
  });

  testWidgets('mid width (720 dp): cards in two columns, no overflow', (tester) async {
    await setSurface(tester, const Size(720, 1024));
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('TRỪ KHO'), findsNWidgets(3));
    final a = tester.getTopLeft(find.text('Cà phê sữa'));
    final b = tester.getTopLeft(find.text('Bạc xỉu'));
    expect(a.dy, b.dy); // side by side
  });

  testWidgets('filter box is accent-insensitive and shows the no-match text', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Tìm theo tên, SKU, từ khóa…'), 'bac xiu');
    await tester.pumpAndSettle();
    expect(find.text('Bạc xỉu'), findsOneWidget);
    expect(find.text('Cà phê sữa'), findsNothing);

    await tester.enterText(find.widgetWithText(TextField, 'Tìm theo tên, SKU, từ khóa…'), 'nuoc suoi');
    await tester.pumpAndSettle();
    expect(find.text('Nước suối Aquafina'), findsOneWidget);
    expect(find.text('Bạc xỉu'), findsNothing);

    await tester.enterText(find.widgetWithText(TextField, 'Tìm theo tên, SKU, từ khóa…'), 'zzz');
    await tester.pumpAndSettle();
    expect(find.text('Không có món phù hợp.'), findsOneWidget);
  });

  testWidgets('Sửa: the product sheet saves name/price/category/aliases with PUT /products/:id', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.byTooltip('Sửa Cà phê sữa'));
    expect(find.text('Sửa Cà phê sữa'), findsOneWidget);
    expect(find.text('cf sữa\nca phe sua'), findsOneWidget);
    expect(find.text('Hàng trong kho (chỉ hàng bán lẻ)'), findsNothing); // BOM drink: no stock item

    await tester.enterText(field('Giá bán (đ)'), '30000');
    await tester.enterText(field('Từ khóa đặt món qua Zalo'), 'cf sữa\nca phe sua, cafe sua');
    await tapVisible(tester, find.text('Lưu'));

    final body = verify(() => api.put('/products/1', captureAny())).captured.single;
    expect(body, {
      'name': 'Cà phê sữa',
      'price': 30000,
      'category_id': 1,
      'is_active': true,
      'aliases': ['cf sữa', 'ca phe sua', 'cafe sua'],
    });
    expect(find.text('Đã cập nhật Cà phê sữa.'), findsOneWidget);
    verify(() => api.get('/admin/menu', query: any(named: 'query'))).called(2);
  });

  testWidgets('+ Hàng bán lẻ: requires the stock item, then POST /products with stock_mode direct', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('+ Hàng bán lẻ'));
    expect(find.text('Thêm hàng bán lẻ'), findsOneWidget);
    await tester.enterText(field('Tên món'), 'Nước cam');
    await tester.enterText(field('Mã (SKU)'), 'NUOC-CAM');
    await tester.enterText(field('Giá bán (đ)'), '20000');
    await tester.enterText(field('Từ khóa đặt món qua Zalo'), 'nuoc cam');
    await tapVisible(tester, find.text('Lưu'));
    expect(find.text('Chọn hàng trong kho cho hàng bán lẻ'), findsOneWidget);
    verifyNever(() => api.post(any(), any()));

    await tapVisible(tester, find.text('— không áp dụng —'));
    await tester.tap(find.text('Aquafina 500ml (chai)').last);
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Lưu'));

    final body = verify(() => api.post('/products', captureAny())).captured.single;
    expect(body, {
      'category_id': 1,
      'sku': 'NUOC-CAM',
      'name': 'Nước cam',
      'price': 20000,
      'stock_mode': 'direct',
      'inventory_item_id': 7,
      'aliases': ['nuoc cam'],
    });
    expect(find.text('Đã thêm Nước cam.'), findsOneWidget);
  });

  testWidgets('+ Nhóm món: code lowercased, hidden group gets PUT is_active false after create', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('+ Nhóm món'));
    await tester.enterText(field('Tên nhóm'), 'Trà sữa');
    await tester.enterText(field('Mã nhóm'), 'Tra Sua');
    await tester.enterText(field('Thứ tự'), '3');
    await tapVisible(tester, find.text('Lưu'));
    expect(find.text('Mã nhóm chỉ gồm chữ thường, số và dấu gạch dưới.'), findsOneWidget);

    await tester.enterText(field('Mã nhóm'), 'Tra_Sua');
    await tapVisible(tester, find.text('Hiển thị nhóm này'));
    await tapVisible(tester, find.text('Lưu'));

    expect(verify(() => api.post('/categories', captureAny())).captured.single, {'code': 'tra_sua', 'name': 'Trà sữa', 'sort_order': 3});
    expect(verify(() => api.put('/categories/9', captureAny())).captured.single, {'is_active': false});
    expect(find.text('Đã thêm nhóm món.'), findsOneWidget);
  });

  testWidgets('tapping a group chip edits it with PUT /categories/:id', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('#9'));
    expect(find.text('Sửa nhóm món'), findsOneWidget);
    await tester.enterText(field('Tên nhóm'), 'Món mùa thu');
    await tapVisible(tester, find.text('Hiển thị nhóm này'));
    await tapVisible(tester, find.text('Lưu'));

    expect(verify(() => api.put('/categories/3', captureAny())).captured.single,
        {'name': 'Món mùa thu', 'sort_order': 9, 'is_active': true});
    expect(find.text('Đã cập nhật nhóm món.'), findsOneWidget);
  });

  testWidgets('quick switch stops selling with PUT /products/:id { is_active }', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.byType(Switch).first);
    expect(verify(() => api.put('/products/1', captureAny())).captured.single, {'is_active': false});
    expect(find.text('Đã cập nhật Cà phê sữa.'), findsOneWidget);
  });

  testWidgets('falls back to /products, /categories, /inventory when /admin/menu is missing', (tester) async {
    when(() => api.get('/admin/menu', query: any(named: 'query')))
        .thenThrow(ApiException(code: 'NOT_FOUND', status: 404, message: 'Không tìm thấy dữ liệu (có thể đã bị xóa).'));
    final full = adminMenu();
    final products = [
      for (final p in full['products'] as List)
        Map<String, dynamic>.from(p as Map)
          ..remove('aliases')
          ..remove('inventory_item_name'),
    ];
    when(() => api.get('/products', query: any(named: 'query'))).thenAnswer((_) async => {'products': products});
    when(() => api.get('/categories', query: any(named: 'query'))).thenAnswer((_) async => {'categories': full['categories']});
    when(() => api.get('/inventory', query: any(named: 'query'))).thenAnswer((_) async => {'items': full['items']});
    when(() => api.get('/products/3', query: any(named: 'query'))).thenAnswer((_) async => {
          'product': {'id': 3, 'aliases': ['Nước suối Aquafina', 'nuoc suoi']},
        });

    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('MÓN (3)'), findsOneWidget);
    expect(find.text('Aquafina 500ml'), findsOneWidget); // joined from /inventory
    expect(verify(() => api.get('/products', query: captureAny(named: 'query'))).captured.single, {'all': 1});

    await tapVisible(tester, find.byTooltip('Sửa Nước suối Aquafina'));
    expect(find.text('nuoc suoi'), findsOneWidget); // loaded from GET /products/3
  });

  testWidgets('cashier: read-only lists, no admin endpoint', (tester) async {
    final full = adminMenu();
    when(() => api.get('/products', query: any(named: 'query'))).thenAnswer((_) async => {'products': full['products']});
    when(() => api.get('/categories', query: any(named: 'query'))).thenAnswer((_) async => {'categories': full['categories']});
    when(() => api.get('/inventory', query: any(named: 'query'))).thenAnswer((_) async => {'items': full['items']});

    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const MenuScreen(), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    expect(find.text('Cà phê sữa'), findsOneWidget);
    expect(find.text('+ Hàng bán lẻ'), findsNothing);
    expect(find.byType(Switch), findsNothing);
    expect(find.text('Sửa'), findsNothing);
    verifyNever(() => api.get('/admin/menu', query: any(named: 'query')));
  });

  test('foldVi and parseAliases follow the web helpers', () {
    expect(foldVi('Bạc Xỉu Đá'), 'bac xiu da');
    expect(parseAliases('a, b\nc;; d'), ['a', 'b', 'c', 'd']);
    expect(parseAliases(List.filled(31, 'x').join('\n')), isNull);
    expect(parseAliases('x' * 101), isNull);
  });
}
