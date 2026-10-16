import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import 'settings_models.dart';
import 'user_sheets.dart' show noCounter;

/// The two "connections" cards of Cài đặt that used to exist on the Web Admin only: the iOS download link and the
/// PayOn QR payment keys. Both read GET /api/admin/settings (adminSettingsProvider) and write through
/// PUT /api/admin/settings/ios-app and /api/admin/settings/payon (+ POST .../payon/test and .../payon/ip).
class IntegrationsSection extends ConsumerWidget {
  const IntegrationsSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(adminSettingsProvider);
    return settings.when(
      skipLoadingOnRefresh: true,
      skipLoadingOnReload: true,
      data: (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (s.iosApp != null) IosAppCard(setting: s.iosApp!),
        if (s.iosApp != null && s.payon != null) const SizedBox(height: 16),
        if (s.payon != null) PayonCard(payon: s.payon!),
      ]),
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(), // the printer card above already shows the error with "Thử lại"
    );
  }
}

const _iosHosts = {'testflight.apple.com', 'beta.itunes.apple.com', 'apps.apple.com', 'itunes.apple.com'};

/// Same rule as services/iosApp.js classify(): an https link on Apple's TestFlight / App Store hosts, 300 characters at most.
String? iosLinkRule(String? value) {
  final raw = (value ?? '').trim();
  if (raw.isEmpty) return null;
  const message = 'Liên kết phải là địa chỉ https của TestFlight (testflight.apple.com/join/…) hoặc App Store (apps.apple.com/…).';
  final uri = Uri.tryParse(raw);
  if (uri == null || uri.scheme != 'https' || uri.userInfo.isNotEmpty || !_iosHosts.contains(uri.host.toLowerCase())) return message;
  return uri.toString().length > 300 ? 'Liên kết dài tối đa 300 ký tự.' : null;
}

/// "Ứng dụng iOS (iPhone / iPad)": the link /download/ios and the QR on the login page lead to.
class IosAppCard extends ConsumerStatefulWidget {
  const IosAppCard({super.key, required this.setting});
  final IosAppSetting setting;

  @override
  ConsumerState<IosAppCard> createState() => _IosAppCardState();
}

class _IosAppCardState extends ConsumerState<IosAppCard> {
  final _form = GlobalKey<FormState>();
  late final _url = TextEditingController(text: widget.setting.url);
  bool _busy = false;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final cleared = _url.text.trim().isEmpty;
    final ok = await runWithToast(context, () async {
      await ref.read(apiProvider).put('/admin/settings/ios-app', {'url': _url.text.trim()});
      ref.invalidate(adminSettingsProvider);
    }, success: cleared ? 'Đã bỏ liên kết tải ứng dụng iOS.' : 'Đã lưu liên kết tải ứng dụng iOS.');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok && !cleared) _url.text = _url.text.trim();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.setting;
    final server = ref.watch(serverUrlProvider);
    final page = '$server/download/ios'.replaceFirst(RegExp(r'^https?://'), '');
    return SectionCard(
      title: 'Ứng dụng iOS (iPhone / iPad)',
      subtitle: 'Trang tải $page và mã QR trên trang đăng nhập dẫn tới liên kết này: liên kết công khai TestFlight (bản thử nghiệm) '
          'hoặc trang App Store khi đã phát hành. Để trống khi chưa có; bản Android không bị ảnh hưởng.',
      trailing: s.linkLabel == null ? const StatusBadge('Chưa có liên kết') : StatusBadge(s.linkLabel!, tone: Tone.good),
      child: Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          LabeledField(
            label: 'Liên kết tải (https://testflight.apple.com/join/… hoặc https://apps.apple.com/…)',
            child: TextFormField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              enableSuggestions: false,
              maxLength: 300,
              buildCounter: noCounter,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: const InputDecoration(hintText: 'https://testflight.apple.com/join/XXXXXXXX'),
              validator: iosLinkRule,
            ),
          ),
          if (s.url.isEmpty && s.fallbackUrl != null) ...[
            const SizedBox(height: 8),
            Text('Đang dùng IOS_APP_URL từ biến môi trường: ${s.fallbackUrl}', style: context.tt.bodySmall?.copyWith(color: context.co.muted)),
          ],
          const SizedBox(height: 16),
          Align(
            alignment: Alignment.centerLeft,
            child: LayoutBuilder(builder: (context, c) {
              final button = FilledButton(
                onPressed: _busy ? null : _save,
                child: _busy
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Text('Lưu liên kết'),
              );
              return c.maxWidth < kSheetBreakpoint ? SizedBox(width: double.infinity, child: button) : button;
            }),
          ),
        ]),
      ),
    );
  }
}

/// "Thanh toán QR (PayOn / NextPay)". A blank secret keeps the stored one; fields the server takes from the
/// environment are read-only; switching on needs the full key set and a QR bank from the connection test.
class PayonCard extends ConsumerStatefulWidget {
  const PayonCard({super.key, required this.payon});
  final PayonSettings payon;

  @override
  ConsumerState<PayonCard> createState() => _PayonCardState();
}

class _PayonCardState extends ConsumerState<PayonCard> {
  final _form = GlobalKey<FormState>();
  late String _env = widget.payon.env;
  late String _bank = widget.payon.bankCode;
  late bool _enabled = widget.payon.enabled;
  late final _appId = TextEditingController(text: widget.payon.appId);
  late final _merchant = TextEditingController(text: widget.payon.merchantId);
  late final _user = TextEditingController(text: widget.payon.authUser);
  final _pass = TextEditingController();
  final _key = TextEditingController();
  late final _expire = TextEditingController(text: '${widget.payon.expireMinutes}');
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_appId, _merchant, _user, _pass, _key, _expire]) {
      c.dispose();
    }
    super.dispose();
  }

  bool _locked(String field) => widget.payon.lockedFields.contains(field);

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    String? message;
    final ok = await runWithToast(context, () async {
      final res = await ref.read(apiProvider).put('/admin/settings/payon', {
        'env': _env,
        'appId': _appId.text.trim(),
        'merchantId': _merchant.text.trim(),
        'authUser': _user.text.trim(),
        'authPass': _pass.text,
        'secretKey': _key.text,
        'bankCode': _bank,
        'expireMinutes': int.parse(_expire.text.trim()),
        'enabled': _enabled,
      });
      message = res['message'] is String ? res['message'] as String : null;
      ref.invalidate(adminSettingsProvider);
    }, success: 'Đã lưu cấu hình PayOn.');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _pass.clear();
      _key.clear();
      if (message != null) showToast(context, message!);
    }
  }

  /// Calls PayOn with the SAVED keys and loads the QR bank list.
  Future<void> _test() async {
    setState(() => _busy = true);
    String? message;
    await runWithToast(context, () async {
      final res = await ref.read(apiProvider).post('/admin/settings/payon/test');
      message = res['message'] is String ? res['message'] as String : null;
      ref.invalidate(adminSettingsProvider);
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (message != null) showToast(context, message!);
  }

  Future<void> _showIp() async {
    setState(() => _busy = true);
    String? message;
    await runWithToast(context, () async {
      final res = await ref.read(apiProvider).post('/admin/settings/payon/ip');
      message = res['message'] is String ? res['message'] as String : null;
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (message != null) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('IP máy chủ'),
          content: SelectableText(message!),
          actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Đóng'))],
        ),
      );
    }
  }

  Widget _text(String label, TextEditingController c, int max, {String field = '', bool secret = false, String? hint, String? set,
      TextInputType? keyboard, String? Function(String?)? validator}) {
    final locked = field.isNotEmpty && _locked(field);
    return LabeledField(
      label: set == null ? label : '$label $set',
      hint: locked ? 'Lấy từ biến môi trường (hPanel), không sửa ở đây.' : null,
      child: TextFormField(
        controller: c,
        readOnly: locked,
        obscureText: secret,
        enableSuggestions: !secret,
        autocorrect: false,
        maxLength: max,
        buildCounter: noCounter,
        keyboardType: keyboard,
        autofillHints: secret ? const [AutofillHints.newPassword] : null,
        style: secret ? null : const TextStyle(fontFamily: 'monospace', fontSize: 13),
        decoration: InputDecoration(hintText: hint),
        validator: validator,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payon;
    final badge = p.ready
        ? const StatusBadge('Đang bật', tone: Tone.good)
        : (p.complete ? const StatusBadge('Chưa bật', tone: Tone.warn) : const StatusBadge('Chưa cấu hình'));
    final bankItems = <DropdownMenuItem<String>>[
      const DropdownMenuItem(value: '', child: Text('— bấm "Kiểm tra kết nối" để tải danh sách —', overflow: TextOverflow.ellipsis)),
      for (final b in p.banks) DropdownMenuItem(value: b.code, child: Text(b.name, overflow: TextOverflow.ellipsis)),
      if (_bank.isNotEmpty && !p.banks.any((b) => b.code == _bank))
        DropdownMenuItem(value: _bank, child: Text(p.bankName.isEmpty ? _bank : p.bankName, overflow: TextOverflow.ellipsis)),
    ];
    final fields = <Widget>[
      LabeledField(
        label: 'Môi trường',
        child: DropdownButtonFormField<String>(
          initialValue: _env,
          isExpanded: true,
          items: const [
            DropdownMenuItem(value: 'sandbox', child: Text('Thử nghiệm (sandbox)')),
            DropdownMenuItem(value: 'production', child: Text('Thật (production)')),
          ],
          onChanged: _locked('env') ? null : (v) => setState(() => _env = v ?? 'sandbox'),
        ),
      ),
      _text('APP_ID', _appId, 60, field: 'appId'),
      _text('Mã merchant (MC_ID, số)', _merchant, 20,
          field: 'merchantId',
          keyboard: TextInputType.number,
          validator: (v) => (v ?? '').trim().isNotEmpty && !RegExp(r'^\d+$').hasMatch(v!.trim()) ? 'Mã merchant (MC_ID) phải là số.' : null),
      _text('MC_AUTH_USER', _user, 100, field: 'authUser'),
      _text('MC_AUTH_PASS', _pass, 200,
          field: 'authPass', secret: true, set: p.authPassSet ? '(đã lưu ${p.authPassHint})' : '(chưa có)', hint: p.authPassSet ? 'Để trống = giữ nguyên' : null),
      _text('MC_SECRET_KEY', _key, 200,
          field: 'secretKey', secret: true, set: p.secretKeySet ? '(đã lưu ${p.secretKeyHint})' : '(chưa có)', hint: p.secretKeySet ? 'Để trống = giữ nguyên' : null),
      LabeledField(
        label: 'Ngân hàng nhận tiền bằng QR',
        child: DropdownButtonFormField<String>(
          initialValue: bankItems.any((i) => i.value == _bank) ? _bank : '',
          isExpanded: true,
          items: bankItems,
          onChanged: (v) => setState(() => _bank = v ?? ''),
        ),
      ),
      LabeledField(
        label: 'QR hết hạn sau (phút)',
        child: TextFormField(
          controller: _expire,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          textAlign: TextAlign.right,
          style: const TextStyle(fontFeatures: tabular),
          validator: (v) {
            final n = int.tryParse((v ?? '').trim());
            return n == null || n < 3 || n > 60 ? 'Từ 3 đến 60 phút.' : null;
          },
        ),
      ),
    ];

    return SectionCard(
      title: 'Thanh toán QR (PayOn / NextPay)',
      subtitle: 'Mỗi đơn có một mã QR ngân hàng theo đúng số tiền; khách chuyển khoản xong, PayOn báo về máy chủ và đơn tự chuyển sang "Đã thanh toán".',
      trailing: badge,
      child: Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _Row('Địa chỉ nhận thông báo (url_notify)', p.ipnUrl.isEmpty ? '(chưa đặt PUBLIC_BASE_URL)' : p.ipnUrl),
          _Row('Máy chủ PayOn', p.baseUrl),
          const SizedBox(height: 12),
          LayoutBuilder(builder: (context, c) {
            const gap = 16.0;
            final cols = c.maxWidth >= kTableBreakpoint - 64 ? 3 : (c.maxWidth >= kSheetBreakpoint ? 2 : 1);
            final w = (c.maxWidth - gap * (cols - 1)) / cols;
            return Wrap(spacing: gap, runSpacing: gap, children: [for (final f in fields) SizedBox(width: w, child: f)]);
          }),
          const SizedBox(height: 8),
          InkWell(
            onTap: () => setState(() => _enabled = !_enabled),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Row(children: [
                Checkbox(value: _enabled, onChanged: (v) => setState(() => _enabled = v ?? false)),
                const Flexible(child: Text('Bật thanh toán QR PayOn trên trang đơn hàng', style: TextStyle(fontSize: 14))),
              ]),
            ),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: LayoutBuilder(builder: (context, c) {
              final button = FilledButton(
                onPressed: _busy ? null : _save,
                child: _busy
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Text('Lưu cấu hình PayOn'),
              );
              return c.maxWidth < kSheetBreakpoint ? SizedBox(width: double.infinity, child: button) : button;
            }),
          ),
          const Divider(height: 32),
          Wrap(spacing: 12, runSpacing: 12, children: [
            OutlinedButton(
              onPressed: _busy || !p.complete ? null : _test,
              child: const Text('Kiểm tra kết nối & tải danh sách ngân hàng'),
            ),
            OutlinedButton(onPressed: _busy ? null : _showIp, child: const Text('Xem IP máy chủ (để NextPay khai báo)')),
          ]),
        ]),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Text(label, style: TextStyle(color: context.co.muted, fontSize: 13))),
          const SizedBox(width: 12),
          Flexible(child: SelectableText(value, textAlign: TextAlign.right, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
        ]),
      );
}
