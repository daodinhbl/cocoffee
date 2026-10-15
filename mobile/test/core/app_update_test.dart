import 'package:cocoffee_mobile/core/update/app_update.dart';
import 'package:cocoffee_mobile/features/settings/settings_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final sha = 'A' * 64;

  test('manifest of a newer build is an update, downloaded from the signed-in server', () {
    final r = AppRelease.tryParse({'version_name': '9.9.9', 'version_code': kAppBuild + 1, 'size': 62543324, 'sha256': sha, 'url': 'http://other/x.apk'}, 'https://shop.example');
    expect(r, isNotNull);
    expect(r!.isNewer, isTrue);
    expect(r.url, 'https://shop.example/download/cocoffee.apk');
    expect(r.sha256, 'a' * 64);
    expect(r.label, '9.9.9 (${kAppBuild + 1})');
    expect(r.sizeLabel, '59.6 MB');
  });

  test('the installed build (or older) is not an update', () {
    expect(AppRelease.tryParse({'version_code': kAppBuild, 'sha256': sha}, 's')!.isNewer, isFalse);
    expect(AppRelease.tryParse({'version_code': kAppBuild - 1, 'sha256': sha}, 's')!.isNewer, isFalse);
  });

  test('an unusable manifest is ignored', () {
    expect(AppRelease.tryParse('nope', 's'), isNull);
    expect(AppRelease.tryParse({'version_code': 'x', 'sha256': sha}, 's'), isNull);
    expect(AppRelease.tryParse({'version_code': 9, 'sha256': 'short'}, 's'), isNull);
  });
}
