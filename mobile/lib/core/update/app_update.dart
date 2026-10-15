import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ota_update/ota_update.dart';

import '../../features/settings/settings_models.dart';
import '../session.dart';

/// The build the server offers (GET /download/manifest.json, written by scripts/publish-apk.js).
class AppRelease {
  const AppRelease({required this.versionName, required this.versionCode, required this.size, required this.sha256, required this.url});

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

  bool get isNewer => versionCode > kAppBuild;
  String get label => versionName.isEmpty ? '#$versionCode' : '$versionName ($versionCode)';
  String get sizeLabel => size > 0 ? '${(size / 1048576).toStringAsFixed(1)} MB' : '';
}

/// Off under `flutter test` (no network, no native installer); tests may override it.
final updateCheckEnabledProvider = Provider<bool>((_) => !Platform.environment.containsKey('FLUTTER_TEST'));

/// Asks the server for the newest build; resolves to it only when it is newer than the installed one.
/// Any failure (offline, no release published) resolves to null: a missing update is never an error screen.
/// Invalidate it to check again.
final updateCheckProvider = FutureProvider<AppRelease?>((ref) async {
  if (!ref.watch(updateCheckEnabledProvider) || !Platform.isAndroid) return null;
  final server = ref.watch(serverUrlProvider);
  try {
    final res = await Dio(BaseOptions(connectTimeout: const Duration(seconds: 8), receiveTimeout: const Duration(seconds: 8)))
        .get<dynamic>('$server/download/manifest.json', options: Options(headers: {'Cache-Control': 'no-cache'}));
    final release = AppRelease.tryParse(res.data, server);
    return release != null && release.isNewer ? release : null;
  } catch (_) {
    return null;
  }
});

/// Dialog that downloads [release], checks its SHA-256 and hands it to Android's installer.
Future<void> showUpdateDialog(BuildContext context, AppRelease release) =>
    showDialog<void>(context: context, barrierDismissible: false, builder: (_) => _UpdateDialog(release: release));

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
