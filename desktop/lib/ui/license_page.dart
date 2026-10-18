import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/license.dart';
import '../core/stack.dart';

/// "Giấy phép": this PC's id (to send to the vendor), the state of the licence, and where to paste the activation code.
class LicenseScreen extends StatefulWidget {
  const LicenseScreen({super.key, required this.stack});
  final StackController stack;
  @override
  State<LicenseScreen> createState() => _LicenseScreenState();
}

class _LicenseScreenState extends State<LicenseScreen> {
  final _code = TextEditingController();
  String? _note;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _activate() async {
    final id = widget.stack.machineId;
    if (id == null) {
      setState(() => _note = 'Không đọc được mã máy của Windows.');
      return;
    }
    setState(() => _busy = true);
    final r = await checkActivationCode(_code.text, machineId: id);
    if (r.state == LicenseState.licensed) {
      widget.stack.config.licenseCode = _code.text.trim();
      widget.stack.store.save(widget.stack.config);
      await widget.stack.recheckLicense();
      _code.clear();
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _note = r.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = widget.stack;
    final st = s.license;
    final color = st == null ? Colors.grey : (st.state == LicenseState.licensed ? Colors.green.shade700 : st.allowed ? Colors.amber.shade800 : Colors.red.shade700);
    final label = switch (st?.state) {
      LicenseState.licensed => 'Đã kích hoạt',
      LicenseState.trial => 'Dùng thử',
      LicenseState.expired => 'Hết hạn',
      LicenseState.wrongMachine => 'Sai máy',
      LicenseState.trialOver => 'Hết thời gian dùng thử',
      LicenseState.clockBack => 'Sai giờ máy tính',
      LicenseState.invalid => 'Không hợp lệ',
      null => 'Chưa kiểm tra',
    };
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Giấy phép', style: t.titleMedium),
      const SizedBox(height: 4),
      Text('Giấy phép gắn với máy tính này. Chép dữ liệu sang máy khác sẽ không chạy được nếu chưa có mã mới.', style: t.bodySmall),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Chip(label: Text(label, style: const TextStyle(color: Colors.white)), backgroundColor: color),
              const SizedBox(width: 12),
              Expanded(child: Text(st?.message ?? 'Đang kiểm tra…')),
            ]),
            if (st?.payload != null) ...[
              const SizedBox(height: 8),
              Text('Khách hàng: ${st!.payload!.customer}'),
              Text('Hiệu lực đến: ${st.payload!.expires.toLocal().toString().substring(0, 10)}${st.state == LicenseState.licensed ? ' (còn ${st.daysLeft} ngày)' : ''}'),
              if (st.payload!.features.isNotEmpty) Text('Tính năng: ${st.payload!.features.join(', ')}'),
            ],
          ]),
        ),
      ),
      const SizedBox(height: 16),
      Text('Mã máy (gửi cho nhà cung cấp để nhận mã kích hoạt)', style: t.labelLarge),
      const SizedBox(height: 4),
      Row(children: [
        Expanded(child: SelectableText(s.machineId ?? 'không đọc được', style: const TextStyle(fontFamily: 'Consolas', fontSize: 17, fontWeight: FontWeight.w600))),
        OutlinedButton.icon(
          onPressed: s.machineId == null
              ? null
              : () async {
                  await Clipboard.setData(ClipboardData(text: s.machineId!));
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Đã sao chép mã máy.')));
                },
          icon: const Icon(Icons.copy_rounded, size: 18),
          label: const Text('Sao chép'),
        ),
      ]),
      const SizedBox(height: 20),
      Text('Mã kích hoạt', style: t.labelLarge),
      const SizedBox(height: 4),
      TextField(controller: _code, minLines: 3, maxLines: 6, decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Dán mã kích hoạt nhận từ nhà cung cấp'), autocorrect: false),
      const SizedBox(height: 8),
      FilledButton.icon(onPressed: _busy || _code.text.trim().isEmpty && false ? null : _activate, icon: const Icon(Icons.verified_rounded), label: const Text('Kích hoạt')),
      if (_note != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_note!, style: TextStyle(color: Theme.of(context).colorScheme.primary))),
    ]);
  }
}
