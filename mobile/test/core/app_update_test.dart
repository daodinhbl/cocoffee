import 'package:cocoffee_mobile/core/update/app_update.dart';
import 'package:cocoffee_mobile/features/settings/settings_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  iosUpdateTests();
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

void iosUpdateTests() {
  test('iOS manifest: only version names are compared, and the install link is rebuilt from the signed-in server', () {
    final r = AppRelease.tryParseIos({'version_name': '9.0.0', 'version_code': 3, 'size': 9432113, 'install_url': 'itms-services://?action=download-manifest&url=https://evil/x.plist'}, 'https://shop.example');
    expect(r, isNotNull);
    expect(r!.isNewer, isTrue);
    expect(r.installUrl, 'itms-services://?action=download-manifest&url=https%3A%2F%2Fshop.example%2Fdownload%2Fios%2Fmanifest.plist');
    expect(r.label, '9.0.0');
    expect(AppRelease.tryParseIos({'version_name': kAppVersion.split(' ').first}, 's')!.isNewer, isFalse);
    expect(AppRelease.tryParseIos({'version_name': ''}, 's'), isNull);
    expect(AppRelease.tryParseIos('nope', 's'), isNull);
  });

  test('version names compare numerically', () {
    expect(versionNameIsNewer('1.10.0', '1.9.9'), isTrue);
    expect(versionNameIsNewer('1.6.0', '1.6.0'), isFalse);
    expect(versionNameIsNewer('1.6', '1.6.0'), isFalse);
    expect(versionNameIsNewer('1.5.9', '1.6.0'), isFalse);
    expect(versionNameIsNewer('2.0', '1.9.9'), isTrue);
  });
}
