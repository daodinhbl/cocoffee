import 'package:flutter/material.dart';

import '../core/config.dart';
import '../core/stack.dart';

/// "Hostinger": the shop's database lives on this PC (works without internet); when the PC is online it copies to the Hostinger
/// database, so the web site and the app away from the shop see the same data. LOCAL IS THE PRIMARY: keep entering data here.
class SyncPage extends StatefulWidget {
  const SyncPage({super.key, required this.stack});
  final StackController stack;
  @override
  State<SyncPage> createState() => _SyncPageState();
}

class _SyncPageState extends State<SyncPage> {
  CloudConfig get k => widget.stack.config.cloud;
  late final _host = TextEditingController(text: k.host);
  late final _port = TextEditingController(text: '${k.port}');
  late final _name = TextEditingController(text: k.name);
  late final _user = TextEditingController(text: k.user);
  late final _pass = TextEditingController(text: k.password);
  late final _minutes = TextEditingController(text: '${k.minutes}');
  bool _busy = false;
  bool _show = false;
  String _output = '';

  @override
  void dispose() {
    for (final t in [_host, _port, _name, _user, _pass, _minutes]) {
      t.dispose();
    }
    super.dispose();
  }

  void _apply() {
    k
      ..host = _host.text.trim()
      ..port = int.tryParse(_port.text.trim()) ?? 3306
      ..name = _name.text.trim()
      ..user = _user.text.trim()
      ..password = _pass.text
      ..minutes = (int.tryParse(_minutes.text.trim()) ?? 5).clamp(1, 1440);
    widget.stack.store.save(widget.stack.config);
  }

  Future<void> _run(String what, Future<({bool ok, String output})> Function() action) async {
    _apply();
    setState(() {
      _busy = true;
      _output = '$what…';
    });
    final r = await action();
    if (mounted) {
      setState(() {
        _busy = false;
        _output = '${r.ok ? '✔' : '✖'} $what\n${r.output}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final st = widget.stack.syncStatus();
    final statusText = st == null
        ? 'Chưa chạy lần nào.'
        : '${{'ok': 'Đồng bộ tốt', 'offline': 'Chưa có mạng tới Hostinger (sẽ thử lại)', 'failed': 'Lỗi', 'idle': 'Chờ'}[st['state']] ?? st['state']}'
            '${st['lastOkAt'] == null ? '' : ' · lần thành công cuối: ${st['lastOkAt']}'}'
            '${st['error'] == null ? '' : '\n${st['error']}'}';
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Đồng bộ với CSDL trên Hostinger', style: t.titleMedium),
      const SizedBox(height: 4),
      Text(
        'Máy này giữ dữ liệu thật của quán và vẫn bán hàng khi mất mạng. Khi có mạng, các thay đổi được chép lên CSDL Hostinger để xem từ xa. '
        'Nên chỉ nhập dữ liệu ở máy này; nhập đồng thời ở Hostinger có thể bị ghi đè. Trong hPanel > Remote MySQL cần cho phép IP của máy này kết nối.',
        style: t.bodySmall,
      ),
      const SizedBox(height: 12),
      Row(children: [
        Expanded(flex: 3, child: TextField(controller: _host, decoration: const InputDecoration(labelText: 'Máy chủ (ví dụ srv2089.hstgr.io)'))),
        const SizedBox(width: 12),
        SizedBox(width: 110, child: TextField(controller: _port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Cổng'))),
      ]),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: TextField(controller: _name, decoration: const InputDecoration(labelText: 'Tên CSDL'))),
        const SizedBox(width: 12),
        Expanded(child: TextField(controller: _user, decoration: const InputDecoration(labelText: 'Người dùng'))),
        const SizedBox(width: 12),
        Expanded(child: TextField(controller: _pass, obscureText: !_show, decoration: InputDecoration(labelText: 'Mật khẩu', suffixIcon: IconButton(icon: Icon(_show ? Icons.visibility_off_rounded : Icons.visibility_rounded), onPressed: () => setState(() => _show = !_show))))),
      ]),
      const SizedBox(height: 8),
      Row(children: [
        SizedBox(width: 200, child: TextField(controller: _minutes, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Đồng bộ mỗi (phút)'))),
        const SizedBox(width: 16),
        Expanded(child: SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Tự đồng bộ nền'), subtitle: const Text('Áp dụng sau khi khởi động lại máy chủ web'), value: k.enabled, onChanged: (v) => setState(() => k.enabled = v))),
      ]),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton.icon(
          onPressed: _busy ? null : () => _run('Lưu và khởi động lại máy chủ web', () async {
            _apply();
            await widget.stack.restartWeb();
            return (ok: true, output: 'Đã áp dụng.');
          }),
          icon: const Icon(Icons.save_rounded),
          label: const Text('Lưu và áp dụng'),
        ),
        OutlinedButton.icon(onPressed: _busy ? null : () => _run('Xem trước: sẽ chép lên Hostinger', () => widget.stack.runSync('push', dryRun: true)), icon: const Icon(Icons.visibility_rounded), label: const Text('Xem trước (không ghi)')),
        OutlinedButton.icon(onPressed: _busy ? null : () => _run('Chép dữ liệu lên Hostinger', () => widget.stack.runSync('push')), icon: const Icon(Icons.cloud_upload_rounded), label: const Text('Đồng bộ lên ngay')),
        OutlinedButton.icon(onPressed: _busy ? null : () => _confirmPull(), icon: const Icon(Icons.cloud_download_rounded), label: const Text('Lấy dữ liệu từ Hostinger (lần đầu)')),
      ]),
      const SizedBox(height: 16),
      Card(child: Padding(padding: const EdgeInsets.all(14), child: Text('Trạng thái đồng bộ nền: $statusText'))),
      if (_output.isNotEmpty) ...[const SizedBox(height: 12), Card(child: Padding(padding: const EdgeInsets.all(12), child: SelectableText(_output, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12.5))))],
    ]);
  }

  Future<void> _confirmPull() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Lấy dữ liệu từ Hostinger về máy này?'),
        content: const Text('Dùng khi cài mới để máy này có sẵn dữ liệu đang chạy trên Hostinger. Dữ liệu trùng mã sẽ bị ghi đè bằng bản của Hostinger. Nên làm trước khi nhập dữ liệu mới ở máy này.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Hủy')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Lấy về'))],
      ),
    );
    if (ok == true) await _run('Lấy dữ liệu từ Hostinger', () => widget.stack.runSync('pull', full: true));
  }
}
