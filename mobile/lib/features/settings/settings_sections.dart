import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import 'settings_models.dart';
import 'user_sheets.dart';

/// "Đổi mật khẩu": POST /api/auth/change-password { current_password, new_password } -> { ok, token }. The fresh
/// token replaces the stored one (every older token stops working) and lifts the "must change password" gate.
class PasswordCard extends ConsumerStatefulWidget {
  const PasswordCard({super.key});

  @override
  ConsumerState<PasswordCard> createState() => _PasswordCardState();
}

class _PasswordCardState extends ConsumerState<PasswordCard> {
  final _form = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _new = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _current.dispose();
    _new.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final ok = await runWithToast(context, () async {
      try {
        final res = await ref.read(apiProvider).post('/auth/change-password', {
          'current_password': _current.text,
          'new_password': _new.text,
        });
        final token = res['token'];
        await ref.read(authProvider.notifier).passwordChanged(token is String ? token : null);
      } on ApiException catch (e) {
        final text = switch (e.code) {
          'BAD_CREDENTIALS' => 'Mật khẩu hiện tại không đúng.',
          'DEMO_ACCOUNT' => 'Tài khoản demo không đổi được mật khẩu.',
          _ => null,
        };
        if (text == null) rethrow;
        throw ApiException(code: e.code, status: e.status, serverMessage: e.serverMessage, message: text);
      }
    }, success: 'Đã đổi mật khẩu.');
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _current.clear();
      _new.clear();
      _confirm.clear();
    }
  }

  Widget _field(String label, TextEditingController c, String? Function(String?) validator, {List<String> hints = const []}) =>
      LabeledField(
        label: label,
        child: TextFormField(
          controller: c,
          obscureText: true,
          maxLength: 200,
          buildCounter: noCounter,
          autofillHints: hints,
          validator: validator,
        ),
      );

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Đổi mật khẩu',
      child: Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _field('Mật khẩu hiện tại', _current, (v) => (v ?? '').isEmpty ? 'Nhập mật khẩu hiện tại' : null,
              hints: const [AutofillHints.password]),
          const SizedBox(height: 16),
          _field('Mật khẩu mới (tối thiểu 10 ký tự)', _new, (v) {
            final rule = passwordRule(v);
            if (rule != null) return rule;
            return v == _current.text ? 'Mật khẩu mới phải khác mật khẩu cũ.' : null;
          }, hints: const [AutofillHints.newPassword]),
          const SizedBox(height: 16),
          _field('Nhập lại mật khẩu mới', _confirm, (v) => v != _new.text ? 'Mật khẩu nhập lại không khớp.' : null,
              hints: const [AutofillHints.newPassword]),
          const SizedBox(height: 20),
          Align(
            alignment: Alignment.centerLeft,
            child: LayoutBuilder(builder: (context, c) {
              final button = FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Text('Đổi mật khẩu'),
              );
              return c.maxWidth < kSheetBreakpoint ? SizedBox(width: double.infinity, child: button) : button;
            }),
          ),
        ]),
      ),
    );
  }
}

/// "Cấu hình hệ thống" (read-only).
class ConfigCard extends StatelessWidget {
  const ConfigCard({super.key, required this.config});
  final SystemConfig config;

  Widget _onOff(bool v) => v ? const StatusBadge('Bật', tone: Tone.good) : const StatusBadge('Tắt', tone: Tone.neutral);

  @override
  Widget build(BuildContext context) {
    final c = config;
    const mono = TextStyle(fontFamily: 'monospace', fontSize: 13);
    final rows = <(String, Widget)>[
      ('Tên quán (SHOP_NAME)', Text(c.shopName.isEmpty ? '—' : c.shopName, textAlign: TextAlign.right)),
      ('Tên miền công khai', Text(c.publicBaseUrl, style: mono, textAlign: TextAlign.right)),
      ('Cho phép bán khi âm kho', _onOff(c.allowNegativeStock)),
      ('Đơn nháp Zalo hết hạn sau', Text('${c.draftTtlMinutes} phút')),
      ('Xác thực chữ ký Zalo', _onOff(c.verifySignature)),
      ('Bill dạng hình ảnh', _onOff(c.receiptImage)),
      ('Múi giờ cơ sở dữ liệu', Text(c.timezone, style: mono)),
      ('Phiên đăng nhập', Text(c.sessionHours, style: mono)),
    ];
    return SectionCard(
      title: 'Cấu hình hệ thống',
      subtitle: 'Chỉ đọc. Thay đổi trong biến môi trường của ứng dụng (hPanel) rồi khởi động lại.',
      child: Column(children: [
        for (final (label, value) in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(children: [
              Expanded(child: Text(label, style: TextStyle(color: context.co.muted, fontSize: 14))),
              const SizedBox(width: 12),
              Flexible(child: Align(alignment: Alignment.centerRight, child: value)),
            ]),
          ),
      ]),
    );
  }
}

/// "Máy in hóa đơn": PUT /api/admin/settings/printer with the whole form.
class PrinterCard extends ConsumerStatefulWidget {
  const PrinterCard({super.key, required this.printer});
  final PrinterSettings printer;

  @override
  ConsumerState<PrinterCard> createState() => _PrinterCardState();
}

class _PrinterCardState extends ConsumerState<PrinterCard> {
  final _form = GlobalKey<FormState>();
  late int _paper = widget.printer.paperMm;
  late int _copies = widget.printer.copies;
  late bool _autoPrint = widget.printer.autoPrint;
  late bool _showVat = widget.printer.showVat;
  late final _vat = TextEditingController(text: '${widget.printer.vatRate}');
  late final _name = TextEditingController(text: widget.printer.printerName);
  late final _address = TextEditingController(text: widget.printer.shopAddress);
  late final _phone = TextEditingController(text: widget.printer.shopPhone);
  late final _footer = TextEditingController(text: widget.printer.footer);
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_vat, _name, _address, _phone, _footer]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    await runWithToast(context, () async {
      await ref.read(apiProvider).put('/admin/settings/printer', {
        'paperMm': _paper,
        'autoPrint': _autoPrint,
        'copies': _copies,
        'printerName': _name.text.trim(),
        'shopAddress': _address.text.trim(),
        'shopPhone': _phone.text.trim(),
        'footer': _footer.text.trim(),
        'showVat': _showVat,
        'vatRate': int.parse(_vat.text.trim()),
      });
      ref.invalidate(adminSettingsProvider);
    }, success: 'Đã lưu cấu hình máy in.');
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _printSample() async {
    final server = ref.read(serverUrlProvider);
    final ok = await launchUrl(Uri.parse('$server/admin/pos/receipt/sample'), mode: LaunchMode.externalApplication);
    if (!ok && mounted) showToast(context, 'Không mở được trình duyệt.', error: true);
  }

  Widget _text(String label, TextEditingController c, int max, {String? hint, TextInputType? keyboard}) => LabeledField(
        label: label,
        child: TextFormField(
          controller: c,
          maxLength: max,
          buildCounter: noCounter,
          keyboardType: keyboard,
          decoration: InputDecoration(hintText: hint),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final paper = LabeledField(
      label: 'Khổ giấy',
      child: SegmentedButton<int>(
        showSelectedIcon: false,
        segments: const [
          ButtonSegment(value: 80, label: Text('80mm')),
          ButtonSegment(value: 58, label: Text('58mm')),
        ],
        selected: {_paper},
        onSelectionChanged: (s) => setState(() => _paper = s.first),
      ),
    );
    final copies = LabeledField(
      label: 'Số liên',
      child: DropdownButtonFormField<int>(
        initialValue: _copies,
        isExpanded: true,
        items: [for (final n in [1, 2, 3]) DropdownMenuItem(value: n, child: Text('$n liên'))],
        onChanged: (v) => setState(() => _copies = v ?? 1),
      ),
    );
    final vat = LabeledField(
      label: 'Thuế VAT (%)',
      child: TextFormField(
        controller: _vat,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        textAlign: TextAlign.right,
        style: const TextStyle(fontFeatures: tabular),
        validator: (v) {
          final n = int.tryParse((v ?? '').trim());
          return n == null || n < 0 || n > 20 ? 'Thuế VAT từ 0 đến 20%.' : null;
        },
      ),
    );
    final name = _text('Tên máy in (ghi chú)', _name, 100, hint: 'VD: Xprinter XP-80C quầy 1');
    final address = _text('Địa chỉ in trên hóa đơn', _address, 200, hint: 'Số nhà, đường, phường, thành phố');
    final phone = _text('Điện thoại', _phone, 30, keyboard: TextInputType.phone);
    final footer = _text('Lời chào cuối hóa đơn', _footer, 255);
    final checks = Wrap(spacing: 24, children: [
      _Check(label: 'Tự động in sau khi thanh toán ở POS', value: _autoPrint, onChanged: (v) => setState(() => _autoPrint = v)),
      _Check(label: 'Hiện dòng "Đã gồm VAT" trên hóa đơn', value: _showVat, onChanged: (v) => setState(() => _showVat = v)),
    ]);
    final save = FilledButton(
      onPressed: _busy ? null : _save,
      child: _busy
          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
          : const Text('Lưu cấu hình máy in'),
    );

    return SectionCard(
      title: 'Máy in hóa đơn',
      subtitle: 'Áp dụng cho hóa đơn in từ màn hình bán hàng (POS) và trang chi tiết đơn.',
      trailing: OutlinedButton.icon(
        onPressed: _printSample,
        icon: const Icon(Icons.receipt_long_outlined, size: 18),
        label: const Text('In thử'),
      ),
      child: Form(
        key: _form,
        child: LayoutBuilder(builder: (context, c) {
          const gap = SizedBox(width: 16, height: 16);
          if (c.maxWidth >= kTableBreakpoint - 64) {
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(flex: 4, child: paper),
                gap,
                Expanded(flex: 2, child: copies),
                gap,
                Expanded(flex: 2, child: vat),
                gap,
                Expanded(flex: 4, child: name),
              ]),
              gap,
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(flex: 8, child: address),
                gap,
                Expanded(flex: 4, child: phone),
              ]),
              gap,
              footer,
              const SizedBox(height: 8),
              checks,
              const SizedBox(height: 12),
              Align(alignment: Alignment.centerLeft, child: save),
            ]);
          }
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            paper,
            gap,
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: copies), gap, Expanded(child: vat)]),
            gap,
            name,
            gap,
            address,
            gap,
            phone,
            gap,
            footer,
            const SizedBox(height: 8),
            checks,
            const SizedBox(height: 12),
            save,
          ]);
        }),
      ),
    );
  }
}

class _Check extends StatelessWidget {
  const _Check({required this.label, required this.value, required this.onChanged});
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onChanged(!value),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Checkbox(value: value, onChanged: (v) => onChanged(v ?? false)),
          Flexible(child: Text(label, style: const TextStyle(fontSize: 14))),
        ]),
      ),
    );
  }
}

/// "Tài khoản nhân viên (n)": add, reset password, lock / unlock (not on your own row).
class UsersSection extends ConsumerWidget {
  const UsersSection({super.key});

  Future<void> _add(BuildContext context, WidgetRef ref) async {
    final username = await showFormSheet<String>(context, builder: (_) => const UserForm());
    if (username == null || !context.mounted) return;
    ref.invalidate(staffUsersProvider);
    showToast(context, 'Đã tạo tài khoản $username.');
  }

  Future<void> _reset(BuildContext context, StaffUser u) async {
    final ok = await showFormSheet<bool>(context, builder: (_) => ResetPasswordForm(user: u));
    if (ok == true && context.mounted) showToast(context, 'Đã đặt lại mật khẩu cho ${u.username}.');
  }

  Future<void> _toggle(BuildContext context, WidgetRef ref, StaffUser u) async {
    if (u.isActive && !await confirmAction(context, 'Khóa tài khoản ${u.username}? Người này sẽ không đăng nhập được nữa.')) return;
    if (!context.mounted) return;
    await runWithToast(context, () async {
      await ref.read(apiProvider).put('/admin/users/${u.id}/active', {'active': !u.isActive});
      ref.invalidate(staffUsersProvider);
    }, success: u.isActive ? 'Đã vô hiệu hóa ${u.username}.' : 'Đã kích hoạt ${u.username}.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(staffUsersProvider);
    final me = ref.watch(currentUserProvider)?.id;
    final count = users.asData?.value.length;

    List<Widget> actions(StaffUser u) => u.id == me
        ? const []
        : [
            GhostAction(label: 'Đặt lại mật khẩu', onPressed: () => _reset(context, u)),
            GhostAction(label: u.isActive ? 'Khóa' : 'Mở khóa', onPressed: () => _toggle(context, ref, u)),
          ];
    Widget title(StaffUser u) => Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, runSpacing: 4, children: [
          Text(u.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
          Text(u.username, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: context.co.muted)),
          if (u.id == me) const StatusBadge('Bạn', tone: Tone.info, dense: true),
        ]);
    Widget status(StaffUser u) =>
        u.isActive ? const StatusBadge('Hoạt động', tone: Tone.good) : const StatusBadge('Đã khóa', tone: Tone.neutral);

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(
          child: Text(count == null ? 'Tài khoản nhân viên' : 'Tài khoản nhân viên ($count)',
              style: context.tt.titleMedium?.copyWith(color: context.cs.onSurface)),
        ),
        FilledButton(onPressed: () => _add(context, ref), child: const Text('+ Thêm tài khoản')),
      ]),
      const SizedBox(height: 12),
      AsyncBody<List<StaffUser>>(
        value: users,
        onRetry: () => ref.invalidate(staffUsersProvider),
        data: (list) => LayoutBuilder(builder: (context, c) {
          if (c.maxWidth >= kTableBreakpoint - 64) {
            return WideTable(
              columns: const [
                WideColumn('Tài khoản', flex: 4),
                WideColumn('Vai trò', flex: 2),
                WideColumn('Trạng thái', flex: 2),
                WideColumn('', flex: 4, end: true),
              ],
              rows: [
                for (final u in list)
                  WideRow(dimmed: !u.isActive, cells: [
                    title(u),
                    Text(roleLabel(u.role)),
                    status(u),
                    Wrap(alignment: WrapAlignment.end, children: actions(u)),
                  ]),
              ],
            );
          }
          return CardGrid(children: [
            for (final u in list)
              RowCard(
                dimmed: !u.isActive,
                title: title(u),
                fields: [('Vai trò', Text(roleLabel(u.role))), ('Trạng thái', status(u))],
                actions: actions(u),
              ),
          ]);
        }),
      ),
    ]);
  }
}

/// App-only: server address (editable; changing it signs out) and app version.
class AppInfoCard extends ConsumerWidget {
  const AppInfoCard({super.key});

  Future<void> _editServer(BuildContext context, WidgetRef ref) async {
    final current = ref.read(serverUrlProvider);
    final ctrl = TextEditingController(text: current);
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Địa chỉ máy chủ'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(controller: ctrl, keyboardType: TextInputType.url, autocorrect: false, decoration: const InputDecoration(hintText: kDefaultServer)),
          const SizedBox(height: 8),
          Text('Máy ảo Android chạy cùng máy tính: http://10.0.2.2:3000', style: ctx.tt.bodySmall),
          const SizedBox(height: 4),
          Text('Đổi máy chủ sẽ đăng xuất để đăng nhập lại.', style: ctx.tt.bodySmall?.copyWith(color: ctx.co.warn)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, kDefaultServer), child: const Text('Mặc định')),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Lưu')),
        ],
      ),
    );
    if (url == null || !context.mounted) return;
    final clean = url.trim().replaceAll(RegExp(r'/+$'), '');
    if (!clean.startsWith('http')) {
      showToast(context, 'Địa chỉ máy chủ phải bắt đầu bằng http:// hoặc https://', error: true);
      return;
    }
    if (clean == current) return;
    await ref.read(serverUrlProvider.notifier).set(clean);
    await ref.read(authProvider.notifier).logout();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final server = ref.watch(serverUrlProvider);
    return SectionCard(
      title: 'Ứng dụng',
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Column(children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.dns_outlined),
          title: const Text('Địa chỉ máy chủ'),
          subtitle: Text(server.replaceFirst(RegExp(r'^https?://'), ''), style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
          trailing: GhostAction(label: 'Đổi', icon: Icons.edit_outlined, onPressed: () => _editServer(context, ref)),
        ),
        const Divider(),
        const ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.info_outline_rounded),
          title: Text('Phiên bản ứng dụng'),
          trailing: Text(kAppVersion, style: TextStyle(fontFeatures: tabular)),
        ),
      ]),
    );
  }
}
