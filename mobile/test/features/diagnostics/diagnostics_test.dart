import 'dart:io';

import 'package:cocoffee_mobile/core/diagnostics/app_log.dart';
import 'package:cocoffee_mobile/features/diagnostics/diagnostics_screen.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../helpers/test_app.dart';

void main() {
  test('the log keeps the latest entries, newest first, and survives a restart through app.log', () async {
    final dir = await Directory.systemTemp.createTemp('applog');
    addTearDown(() => dir.delete(recursive: true));
    final log = AppLog.instance;
    await log.clear();
    await log.install(dir);
    for (var i = 0; i < AppLog.maxEntries + 5; i++) {
      log.record('warn', 'dòng $i');
    }
    log.record('error', 'lỗi\ncuối   cùng');
    expect(log.entries.length, AppLog.maxEntries);
    expect(log.entries.first.message, 'lỗi cuối cùng', reason: 'one line, newest first');
    expect(log.entries.first.level, 'error');
    expect(log.dump().split('\n').last, contains('lỗi cuối cùng'));
    await log.flush();
    final saved = await File('${dir.path}${Platform.pathSeparator}app.log').readAsLines();
    expect(saved.last, contains('lỗi cuối cùng'));
    await log.clear();
    expect(log.entries, isEmpty);
    log.detachFile();
  });

  testWidgets('the screen shows the facts and the recorded errors', (tester) async {
    await setSurface(tester, phone);
    AppLog.instance.record('error', 'Flutter: giả lập lỗi hiển thị');
    final app = await testApp(const DiagnosticsScreen(), api: MockApi());
    await tester.pumpWidget(app);
    await tester.pumpAndSettle();
    expect(find.text('Phiên bản'), findsOneWidget);
    expect(find.textContaining('1.'), findsWidgets);
    expect(find.text('Thao tác chờ gửi'), findsOneWidget);
    expect(find.textContaining('giả lập lỗi hiển thị'), findsOneWidget);
    await AppLog.instance.clear();
  });
}
