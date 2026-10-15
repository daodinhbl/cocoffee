import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';

/// Shown under "Ứng dụng"; keep in step with `version:` in pubspec.yaml.
const kAppVersion = '1.4.0 (5)';

/// versionCode (the number after `+` in pubspec.yaml): the OTA update compares it with the server's manifest.
const kAppBuild = 5;

int _int(Object? v, int fallback) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? fallback;
bool _bool(Object? v) => v == true || v == 1 || v == '1' || v == 'true';
String _str(Object? v) => v == null ? '' : '$v';

/// Value of [key] (camelCase as printerSettings.get() returns it) or its snake_case twin.
Object? _pick(Map<String, dynamic> j, String key) =>
    j.containsKey(key) ? j[key] : j[key.replaceAllMapped(RegExp('[A-Z]'), (m) => '_${m[0]!.toLowerCase()}')];

/// printerSettings.get(): { paperMm, autoPrint, copies, printerName, shopAddress, shopPhone, footer, showVat, vatRate }.
class PrinterSettings {
  const PrinterSettings({
    required this.paperMm,
    required this.autoPrint,
    required this.copies,
    required this.printerName,
    required this.shopAddress,
    required this.shopPhone,
    required this.footer,
    required this.showVat,
    required this.vatRate,
  });

  factory PrinterSettings.fromJson(Map<String, dynamic> j) => PrinterSettings(
        paperMm: _int(_pick(j, 'paperMm'), 80) == 58 ? 58 : 80,
        autoPrint: _bool(_pick(j, 'autoPrint')),
        copies: _int(_pick(j, 'copies'), 1).clamp(1, 3),
        printerName: _str(_pick(j, 'printerName')),
        shopAddress: _str(_pick(j, 'shopAddress')),
        shopPhone: _str(_pick(j, 'shopPhone')),
        footer: _str(_pick(j, 'footer')),
        showVat: _bool(_pick(j, 'showVat')),
        vatRate: _int(_pick(j, 'vatRate'), 0).clamp(0, 20),
      );

  final int paperMm;
  final bool autoPrint;
  final int copies;
  final String printerName;
  final String shopAddress;
  final String shopPhone;
  final String footer;
  final bool showVat;
  final int vatRate;
}

/// Read-only "Cấu hình hệ thống": { publicBaseUrl, allowNegativeStock, draftTtlMinutes, verifySignature,
/// receiptImage, timezone, sessionHours } (+ shopName when the server sends it).
class SystemConfig {
  const SystemConfig({
    required this.shopName,
    required this.publicBaseUrl,
    required this.allowNegativeStock,
    required this.draftTtlMinutes,
    required this.verifySignature,
    required this.receiptImage,
    required this.timezone,
    required this.sessionHours,
  });

  factory SystemConfig.fromJson(Map<String, dynamic> j, {Object? shopName}) {
    final url = _str(_pick(j, 'publicBaseUrl'));
    return SystemConfig(
      shopName: _str(shopName ?? _pick(j, 'shopName')),
      publicBaseUrl: url.isEmpty ? '(chưa đặt)' : url,
      allowNegativeStock: _bool(_pick(j, 'allowNegativeStock')),
      draftTtlMinutes: _int(_pick(j, 'draftTtlMinutes'), 0),
      verifySignature: _bool(_pick(j, 'verifySignature')),
      receiptImage: _bool(_pick(j, 'receiptImage')),
      timezone: _str(_pick(j, 'timezone')),
      sessionHours: _str(_pick(j, 'sessionHours')),
    );
  }

  final String shopName;
  final String publicBaseUrl;
  final bool allowNegativeStock;
  final int draftTtlMinutes;
  final bool verifySignature;
  final bool receiptImage;
  final String timezone;
  final String sessionHours;
}

class AdminSettings {
  const AdminSettings({required this.printer, required this.config});

  /// GET /api/admin/settings -> { printer, config }.
  factory AdminSettings.fromJson(Map<String, dynamic> res) {
    Map<String, dynamic> map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    return AdminSettings(
      printer: PrinterSettings.fromJson(map(res['printer'])),
      config: SystemConfig.fromJson(map(res['config']), shopName: res['shop_name'] ?? res['shopName']),
    );
  }

  final PrinterSettings printer;
  final SystemConfig config;
}

/// userModel.list() row: { id, username, full_name, role, is_active, created_at }.
class StaffUser {
  const StaffUser({required this.id, required this.username, required this.fullName, required this.role, required this.isActive});

  factory StaffUser.fromJson(Map<String, dynamic> j) => StaffUser(
        id: _int(j['id'], 0),
        username: _str(j['username']),
        fullName: _str(j['full_name'] ?? j['username']),
        role: _str(j['role']),
        isActive: j['is_active'] == null || _bool(j['is_active']),
      );

  final int id;
  final String username;
  final String fullName;
  final String role;
  final bool isActive;
}

/// Web ROLE labels in settings.ejs.
String roleLabel(String role) => switch (role) {
      'admin' => 'Quản trị viên',
      'cashier' => 'Thu ngân',
      _ => role,
    };

Duration? _noRetry(int _, Object _) => null;

/// GET /api/admin/settings (admin).
final adminSettingsProvider = FutureProvider.autoDispose<AdminSettings>(
  (ref) async => AdminSettings.fromJson(await ref.watch(apiProvider).get('/admin/settings')),
  retry: _noRetry,
);

/// GET /api/admin/users (admin).
final staffUsersProvider = FutureProvider.autoDispose<List<StaffUser>>((ref) async {
  final res = await ref.watch(apiProvider).get('/admin/users');
  return [for (final r in (res['users'] as List? ?? const [])) if (r is Map) StaffUser.fromJson(Map<String, dynamic>.from(r))];
}, retry: _noRetry);
