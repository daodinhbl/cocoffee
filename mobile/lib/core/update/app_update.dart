import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ota_update/ota_update.dart';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../features/settings/settings_models.dart';
import '../app_mode.dart';
import '../notify/new_order_watcher.dart';
import '../session.dart';

/// True in the Google Play build: Play updates the app itself, so the in-app updater is off and the Settings row is
/// hidden. `--flavor play` alone is enough (Flutter defines FLUTTER_APP_FLAVOR from it), so a Play bundle built without
/// `--dart-define=PLAY_STORE=true` still never downloads or installs an APK, which Play policy forbids.
const kPlayStore = bool.fromEnvironment('PLAY_STORE') || String.fromEnvironment('FLUTTER_APP_FLAVOR') == 'play';

/// True for the ad-hoc iOS build (installed from the shop's /download/ios page). Such a build carries
/// embedded.mobileprovision next to its executable; App Store / TestFlight builds do not, and Apple forbids those from
/// updating themselves, so the updater stays off there.
final bool kIosAdHoc = _isIosAdHoc();

bool _isIosAdHoc() {
  if (!Platform.isIOS) return false;
  try {
    return File('${File(Platform.resolvedExecutable).parent.path}/embedded.mobileprovision').existsSync();
  } catch (_) {
    return false;
  }
}

/// Whether this build may offer in-app updates: Android outside Google Play, iOS only the ad-hoc build.
final bool kSelfUpdate = Platform.isIOS ? kIosAdHoc : !kPlayStore;

/// 1.10.2 > 1.9.9; missing parts count as 0. Used where only the version name is comparable (iOS build numbers come
/// from CI run numbers, not from pubspec).
bool versionNameIsNewer(String candidate, String current) {
  List<int> parts(String v) => v.split('.').map((p) => int.tryParse(p.replaceAll(RegExp(r'[^0-9].*'), '')) ?? 0).toList();
  final a = parts(candidate), b = parts(current);
  for (var i = 0; i < (a.length > b.length ? a.length : b.length); i++) {
    final x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
    if (x != y) return x > y;
  }
  return false;
}

/// The build the server offers (GET /download/manifest.json, written by scripts/publish-apk.js).
class AppRelease {
  const AppRelease({required this.versionName, required this.versionCode, required this.size, required this.sha256, required this.url, this.installUrl});

  /// iOS ad-hoc manifest (GET /download/ios/manifest.json). The itms-services link is rebuilt from the signed-in server,
  /// never taken from the response, so a tampered manifest cannot point the installer elsewhere.
  static AppRelease? tryParseIos(Object? json, String serverUrl) {
    if (json is! Map) return null;
    final name = json['version_name'];
    if (name is! String || name.isEmpty) return null;
    final code = json['version_code'];
    return AppRelease(
      versionName: name,
      versionCode: code is num ? code.toInt() : 0,
      size: json['size'] is num ? (json['size'] as num).toInt() : 0,
      sha256: '',
      url: '$serverUrl/download/ios/app.ipa',
      installUrl: 'itms-services://?action=download-manifest&url=${Uri.encodeComponent('$serverUrl/download/ios/manifest.plist')}',
    );
  }

  /// Null when the manifest is not usable. The download always comes from the server the app is signed in to
  /// (the manifest's own absolute URL can be http behind the host's proxy).
  static AppRelease? tryParse(Object? json, String serverUrl) {
    if (json is! Map) return null;
    final code = json['version_code'];
    final sha = json['sha256'];
    if (code is! num || sha is! String || sha.length != 64) return null;
    return AppRelease(
      versionName: '${json['version_name'] ?? ''}',
      versionCode: code.toInt(),
      size: json['size'] is num ? (json['size'] as num).toInt() : 0,
      sha256: sha.toLowerCase(),
      url: '$serverUrl/download/cocoffee.apk',
    );
  }

  final String versionName;
  final int versionCode;
  final int size;
  final String sha256;
  final String url;

  /// Set only for an iOS release: the link that opens Apple's installer.
  final String? installUrl;

  bool get isNewer => installUrl != null ? versionNameIsNewer(versionName, kAppVersion.split(' ').first) : versionCode > kAppBuild;
  String get label => installUrl != null ? versionName : (versionName.isEmpty ? '#$versionCode' : '$versionName ($versionCode)');
  String get sizeLabel => size > 0 ? '${(size / 1048576).toStringAsFixed(1)} MB' : '';
}

/// Off under `flutter test` (no network, no native installer); tests may override it.
final updateCheckEnabledProvider = Provider<bool>((_) => kSelfUpdate && !Platform.environment.containsKey('FLUTTER_TEST'));

/// Asks the server for the newest build; resolves to it only when it is newer than the installed one.
/// Any failure (offline, no release published) resolves to null: a missing update is never an error screen.
/// Invalidate it to check again.
final updateCheckProvider = FutureProvider<AppRelease?>((ref) async {
  if (!ref.watch(updateCheckEnabledProvider) || !(Platform.isAndroid || Platform.isIOS)) return null;
  final mode = ref.watch(appModeProvider);
  // Local mode has no server of its own: new builds are published on the main site.
  final server = mode == AppMode.server ? ref.watch(serverUrlProvider) : kDefaultServer;
  final ios = Platform.isIOS;
  try {
    final res = await Dio(BaseOptions(connectTimeout: const Duration(seconds: 8), receiveTimeout: const Duration(seconds: 8)))
        .get<dynamic>(ios ? '$server/download/ios/manifest.json' : '$server/download/manifest.json', options: Options(headers: {'Cache-Control': 'no-cache'}));
    final release = ios ? AppRelease.tryParseIos(res.data, server) : AppRelease.tryParse(res.data, server);
    return release != null && release.isNewer ? release : null;
  } catch (_) {
    return null;
  }
});

/// Dialog that downloads [release], checks its SHA-256 and hands it to Android's installer.
Future<void> showUpdateDialog(BuildContext context, AppRelease release) => showDialog<void>(
    context: context,
    barrierDismissible: release.installUrl != null,
    builder: (_) => release.installUrl != null ? _IosUpdateDialog(release: release) : _UpdateDialog(release: release));

/// iOS: Apple's installer does the download and replaces the app in place (the app closes while it installs).
class _IosUpdateDialog extends StatefulWidget {
  const _IosUpdateDialog({required this.release});
  final AppRelease release;

  @override
  State<_IosUpdateDialog> createState() => _IosUpdateDialogState();
}

class _IosUpdateDialogState extends State<_IosUpdateDialog> {
  String? _error;

  Future<void> _install() async {
    try {
      final ok = await launchUrl(Uri.parse(widget.release.installUrl!), mode: LaunchMode.externalApplication);
      if (ok && mounted) {
        Navigator.of(context).pop();
        return;
      }
      if (mounted) setState(() => _error = 'Không mở được trình cài đặt. Hãy mở trang tải của quán bằng Safari và bấm "Cài đặt trực tiếp".');
    } catch (_) {
      if (mounted) setState(() => _error = 'Không mở được trình cài đặt. Hãy mở trang tải của quán bằng Safari và bấm "Cài đặt trực tiếp".');
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.release;
    return AlertDialog(
      title: const Text('Có bản cập nhật mới'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Phiên bản ${r.label}${r.sizeLabel.isEmpty ? '' : ' · ${r.sizeLabel}'}\nĐang dùng: $kAppVersion'),
        const SizedBox(height: 12),
        const Text('iPhone sẽ hỏi xác nhận cài đặt. Ứng dụng đóng lại trong lúc cập nhật; mở lại sau khi biểu tượng tải xong.'),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ],
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Để sau')),
        FilledButton(onPressed: _install, child: const Text('Cập nhật')),
      ],
    );
  }
}

class _UpdateDialog extends StatefulWidget {
  const _UpdateDialog({required this.release});
  final AppRelease release;

  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  StreamSubscription<OtaEvent>? _sub;
  bool _started = false;
  double? _progress;
  String? _error;
  bool _installing = false;

  void _start() {
    setState(() {
      _started = true;
      _error = null;
      _progress = 0;
    });
    try {
      _sub = OtaUpdate()
          .execute(widget.release.url, destinationFilename: 'cocoffee-update.apk', sha256checksum: widget.release.sha256)
          .listen(_onEvent, onError: (Object e) => _fail('$e'));
    } catch (e) {
      _fail('$e');
    }
  }

  void _onEvent(OtaEvent e) {
    if (!mounted) return;
    switch (e.status) {
      case OtaStatus.DOWNLOADING:
        setState(() => _progress = (int.tryParse(e.value ?? '') ?? 0) / 100);
      case OtaStatus.INSTALLING:
        setState(() => _installing = true);
      case OtaStatus.INSTALLATION_DONE:
        Navigator.of(context).pop();
      default:
        _fail(_describe(e));
    }
  }

  String _describe(OtaEvent e) {
    switch (e.status) {
      case OtaStatus.CHECKSUM_ERROR:
        return 'File tải về bị lỗi (sai mã kiểm tra). Hãy thử lại.';
      case OtaStatus.PERMISSION_NOT_GRANTED_ERROR:
        return 'Cần cho phép cài đặt ứng dụng từ nguồn này trong Cài đặt của điện thoại.';
      case OtaStatus.ALREADY_RUNNING_ERROR:
        return 'Đang có một lần cập nhật chạy rồi.';
      case OtaStatus.DOWNLOAD_ERROR:
        return 'Không tải được bản cập nhật. Kiểm tra kết nối rồi thử lại.';
      default:
        return 'Cài đặt không thành công${e.value == null ? '' : ' (${e.value})'}. Nếu máy báo xung đột chữ ký, hãy gỡ bản cũ rồi cài lại.';
    }
  }

  void _fail(String message) {
    if (!mounted) return;
    setState(() {
      _started = false;
      _installing = false;
      _error = message;
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.release;
    return AlertDialog(
      title: const Text('Có bản cập nhật mới'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Phiên bản ${r.label}${r.sizeLabel.isEmpty ? '' : ' · ${r.sizeLabel}'}\nĐang dùng: $kAppVersion'),
        if (_started) ...[
          const SizedBox(height: 16),
          LinearProgressIndicator(value: _installing ? null : _progress),
          const SizedBox(height: 8),
          Text(_installing ? 'Đang mở trình cài đặt…' : 'Đang tải ${((_progress ?? 0) * 100).round()}%'),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ],
      ]),
      actions: [
        if (!_started) TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Để sau')),
        if (!_started) FilledButton(onPressed: _start, child: Text(_error == null ? 'Cập nhật' : 'Thử lại')),
      ],
    );
  }
}

/// Strip above the screens: shown while a newer build is available.
class UpdateBanner extends ConsumerWidget {
  const UpdateBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final release = ref.watch(updateCheckProvider).asData?.value;
    if (release == null) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.primaryContainer,
      child: InkWell(
        onTap: () => showUpdateDialog(context, release),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              Icon(Icons.system_update_rounded, size: 20, color: scheme.onPrimaryContainer),
              const SizedBox(width: 10),
              Expanded(
                  child: Text('Có bản mới ${release.label} — bấm để cập nhật',
                      style: TextStyle(color: scheme.onPrimaryContainer, fontWeight: FontWeight.w600))),
            ]),
          ),
        ),
      ),
    );
  }
}

/// How often a signed-in app asks again whether a newer build exists (it also asks at start and on resume).
const kUpdatePoll = Duration(hours: 4);
const _kNotifiedBuild = 'update_notified_build';

/// Keeps [updateCheckProvider] fresh for every signed-in role (a cashier only ever sees the POS screen, so the
/// news must reach it there) and raises one system notification per new build.
final updateWatcherProvider = Provider<void>((ref) {
  if (!ref.watch(updateCheckEnabledProvider)) return;
  final auth = ref.watch(authProvider);
  if (auth is! SignedIn || auth.user.mustChangePassword) return;

  final timer = Timer.periodic(kUpdatePoll, (_) => ref.invalidate(updateCheckProvider));
  ref.onDispose(timer.cancel);
  final lifecycle = AppLifecycleListener(onResume: () => ref.invalidate(updateCheckProvider));
  ref.onDispose(lifecycle.dispose);

  ref.listen<AsyncValue<AppRelease?>>(updateCheckProvider, (_, next) async {
    final release = next.asData?.value;
    if (release == null) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getInt(_kNotifiedBuild) == release.versionCode) return;   // announced already
      await prefs.setInt(_kNotifiedBuild, release.versionCode);
    } catch (_) {/* announce anyway */}
    final notifier = ref.read(localNotifierProvider);
    await notifier.init();
    await notifier.show(900001, 'Có bản cập nhật ${release.label}', 'Mở ứng dụng và bấm vào thanh thông báo để cập nhật.');
  }, fireImmediately: true);
});
