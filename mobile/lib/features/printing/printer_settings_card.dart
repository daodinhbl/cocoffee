import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'lan_printer.dart';
import 'printer_service.dart';

/// Settings > "Máy in": pick the thermal printer of this phone, Bluetooth (paired) or network (LAN, TCP 9100), and print a test page.
class PrinterSettingsCard extends ConsumerStatefulWidget {
  const PrinterSettingsCard({super.key});
  @override
  ConsumerState<PrinterSettingsCard> createState() => _PrinterSettingsCardState();
}

class _PrinterSettingsCardState extends ConsumerState<PrinterSettingsCard> {
  bool _busy = false;
  int _paper = 80;

  Future<void> _pickBluetooth() async {
    setState(() => _busy = true);
    try {
      final list = await ref.read(printerServiceProvider).paired();
      if (!mounted) return;
      if (list.isEmpty) {
        showToast(context, 'Chưa có máy in nào được ghép đôi. Ghép đôi máy in trong Cài đặt Bluetooth của điện thoại trước.', error: true);
        return;
      }
      final d = await showModalBottomSheet<PrinterDevice>(
        context: context,
        showDragHandle: true,
        builder: (ctx) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            const Padding(padding: EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Chọn máy in Bluetooth', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17))),
            for (final p in list)
              ListTile(leading: const Icon(Icons.bluetooth_rounded), title: Text(p.name), subtitle: Text(p.address), onTap: () => Navigator.pop(ctx, p)),
          ]),
        ),
      );
      if (d != null) await ref.read(savedPrinterProvider.notifier).choose(d);
    } catch (e) {
      if (mounted) showToast(context, printErrorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addLan() async {
    final d = await showDialog<PrinterDevice>(context: context, builder: (_) => const LanPrinterDialog());
    if (d != null) await ref.read(savedPrinterProvider.notifier).choose(d, kind: kindLan);
  }

  Future<void> _test() async {
    setState(() => _busy = true);
    try {
      await ref.read(printerServiceProvider).printTest(paperMm: _paper);
      if (mounted) showToast(context, 'Đã gửi trang in thử.');
    } catch (e) {
      if (mounted) showToast(context, printErrorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final saved = ref.watch(savedPrinterProvider);
    return SectionCard(
      title: 'Máy in của điện thoại này',
      subtitle: 'In trực tiếp từ điện thoại này lên máy in nhiệt 58/80 mm: qua Bluetooth hoặc qua mạng LAN/Wi-Fi (cổng 9100).',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(saved == null ? Icons.print_disabled_outlined : (saved.isLan ? Icons.lan_rounded : Icons.print_rounded), color: saved == null ? context.co.muted : context.co.good),
          const SizedBox(width: 10),
          Expanded(child: Text(saved == null ? 'Chưa chọn máy in' : '${saved.name}\n${saved.isLan ? 'Mạng LAN · ' : 'Bluetooth · '}${saved.address}')),
        ]),
        const SizedBox(height: 12),
        SegmentedButton<int>(
          segments: const [ButtonSegment(value: 58, label: Text('Giấy 58 mm')), ButtonSegment(value: 80, label: Text('Giấy 80 mm'))],
          selected: {_paper},
          onSelectionChanged: (s) => setState(() => _paper = s.first),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(onPressed: _busy ? null : _pickBluetooth, icon: const Icon(Icons.bluetooth_searching_rounded), label: const Text('Chọn máy in Bluetooth')),
          FilledButton.tonalIcon(key: const Key('add-lan-printer'), onPressed: _busy ? null : _addLan, icon: const Icon(Icons.lan_rounded), label: const Text('Thêm máy in mạng LAN')),
          OutlinedButton.icon(onPressed: _busy || saved == null ? null : _test, icon: const Icon(Icons.receipt_long_rounded), label: const Text('In thử máy in')),
          if (saved != null) TextButton(onPressed: _busy ? null : () => ref.read(savedPrinterProvider.notifier).forget(), child: const Text('Bỏ chọn')),
        ]),
      ]),
    );
  }
}

/// Add a network printer: type its IP (and port, default 9100) or let the app look for printers on this Wi-Fi. The connection is
/// tried before it is accepted.
class LanPrinterDialog extends ConsumerStatefulWidget {
  const LanPrinterDialog({super.key, this.connector = realConnector, this.subnetFinder = localSubnet});

  /// Plug-ins for tests.
  final LanConnector connector;
  final Future<String?> Function() subnetFinder;

  @override
  ConsumerState<LanPrinterDialog> createState() => _LanPrinterDialogState();
}

class _LanPrinterDialogState extends ConsumerState<LanPrinterDialog> {
  final _addr = TextEditingController();
  final _name = TextEditingController();
  bool _scanning = false;
  bool _checking = false;
  String? _error;
  List<String> _found = const [];

  @override
  void dispose() {
    _addr.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _error = null;
      _found = const [];
    });
    final subnet = await widget.subnetFinder();
    if (!mounted) return;
    if (subnet == null) {
      setState(() {
        _scanning = false;
        _error = 'Điện thoại chưa nối Wi-Fi/LAN nên không tìm được máy in. Bạn vẫn có thể nhập địa chỉ IP của máy in.';
      });
      return;
    }
    final hosts = await scanLan(subnet, connector: widget.connector, onFound: (h) {
      if (mounted) setState(() => _found = [..._found, h]);
    });
    if (!mounted) return;
    setState(() {
      _scanning = false;
      _found = hosts;
      if (hosts.isEmpty) _error = 'Không thấy máy in nào ở $subnet.x (cổng 9100). Kiểm tra máy in đã bật và cùng mạng, hoặc nhập địa chỉ IP.';
    });
  }

  Future<void> _ok() async {
    final a = LanAddress.parse(_addr.text);
    if (a == null) {
      setState(() => _error = 'Địa chỉ không hợp lệ. Ví dụ: 192.168.1.50 hoặc 192.168.1.50:9100');
      return;
    }
    setState(() {
      _checking = true;
      _error = null;
    });
    final reachable = await widget.connector(a.host, a.port, const Duration(seconds: 4));
    if (!mounted) return;
    if (!reachable) {
      setState(() {
        _checking = false;
        _error = 'Không kết nối được $a. Kiểm tra máy in đã bật, cùng mạng Wi-Fi/LAN và đúng địa chỉ IP.';
      });
      return;
    }
    final name = _name.text.trim().isEmpty ? 'Máy in ${a.host}' : _name.text.trim();
    Navigator.pop(context, PrinterDevice(name, a.toString()));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Thêm máy in mạng LAN'),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(
            controller: _addr,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: const InputDecoration(labelText: 'Địa chỉ IP (và cổng)', hintText: '192.168.1.50:9100'),
          ),
          const SizedBox(height: 8),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Tên gọi (không bắt buộc)', hintText: 'Máy in quầy')),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('scan-lan'),
            onPressed: _scanning || _checking ? null : _scan,
            icon: _scanning ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.travel_explore_rounded),
            label: Text(_scanning ? 'Đang tìm…' : 'Tìm máy in trong mạng'),
          ),
          if (_found.isNotEmpty) ...[
            const SizedBox(height: 8),
            const Text('Thấy các máy (cổng 9100):', style: TextStyle(fontWeight: FontWeight.w600)),
            for (final h in _found)
              ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.print_rounded), title: Text(h), onTap: () => setState(() => _addr.text = h)),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: context.co.bad)),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Hủy')),
        FilledButton(onPressed: _checking || _scanning ? null : _ok, child: Text(_checking ? 'Đang thử…' : 'Thêm')),
      ],
    );
  }
}
