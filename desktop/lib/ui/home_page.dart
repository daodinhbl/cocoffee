import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/license.dart';
import '../core/stack.dart';
import '../core/supervisor.dart';
import 'license_page.dart';
import 'settings_page.dart';
import 'sync_page.dart';

/// Private IPv4 addresses of this PC: what the phones on the same Wi-Fi type in.
Future<List<String>> lanAddresses() async {
  try {
    final out = <String>[];
    for (final i in await NetworkInterface.list(type: InternetAddressType.IPv4, includeLoopback: false)) {
      for (final a in i.addresses) {
        final p = a.address.split('.');
        final priv = p[0] == '192' && p[1] == '168' || p[0] == '10' || p[0] == '172' && (int.tryParse(p[1]) ?? 0) >= 16 && (int.tryParse(p[1]) ?? 0) <= 31;
        if (priv) out.add(a.address);
      }
    }
    return out;
  } catch (_) {
    return const [];
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.stack});
  final StackController stack;
  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  StackController get s => widget.stack;
  Timer? _tick;
  Timer? _licenseTimer;
  List<String> _lan = const [];
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 2), (_) => mounted ? setState(() {}) : null);
    _licenseTimer = Timer.periodic(const Duration(minutes: 10), (_) => s.recheckLicense());
    s.recheckLicense().then((_) => mounted ? setState(() {}) : null);
    lanAddresses().then((v) => mounted ? setState(() => _lan = v) : null);
  }

  @override
  void dispose() {
    _tick?.cancel();
    _licenseTimer?.cancel();
    super.dispose();
  }

  Future<void> _open(String url) => launchUrl(Uri.parse(url));

  @override
  Widget build(BuildContext context) {
    final pages = [_overview(context), SettingsPage(stack: s), SyncPage(stack: s), LicenseScreen(stack: s), _logs(context)];
    return Scaffold(
      appBar: AppBar(title: Text('POS Tasotek Server · ${s.config.shopName}'), backgroundColor: const Color(0xFF172554), foregroundColor: Colors.white),
      body: Row(children: [
        NavigationRail(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          labelType: NavigationRailLabelType.all,
          destinations: const [
            NavigationRailDestination(icon: Icon(Icons.dashboard_rounded), label: Text('Tổng quan')),
            NavigationRailDestination(icon: Icon(Icons.tune_rounded), label: Text('Cài đặt')),
            NavigationRailDestination(icon: Icon(Icons.cloud_sync_rounded), label: Text('Hostinger')),
            NavigationRailDestination(icon: Icon(Icons.verified_user_rounded), label: Text('Giấy phép')),
            NavigationRailDestination(icon: Icon(Icons.article_outlined), label: Text('Nhật ký')),
          ],
        ),
        const VerticalDivider(width: 1),
        Expanded(child: pages[_tab]),
      ]),
    );
  }

  Widget _chip(ServiceState st) {
    final (label, color) = switch (st) {
      ServiceState.running => ('Đang chạy', Colors.green.shade700),
      ServiceState.starting => ('Đang khởi động', Colors.amber.shade800),
      ServiceState.failed => ('Lỗi', Colors.red.shade700),
      ServiceState.stopped => ('Đã dừng', Colors.grey.shade600),
    };
    return Chip(label: Text(label, style: const TextStyle(color: Colors.white, fontSize: 12)), backgroundColor: color, visualDensity: VisualDensity.compact);
  }

  Widget _service(String title, String subtitle, ManagedService svc) => Card(
        child: ListTile(
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text(svc.error ?? subtitle),
          trailing: _chip(svc.current),
        ),
      );

  Widget _addr(String label, String url, {bool qr = false}) => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 4),
                SelectableText(url, style: const TextStyle(fontFamily: 'Consolas', fontSize: 15)),
                const SizedBox(height: 8),
                Wrap(spacing: 8, children: [
                  OutlinedButton.icon(onPressed: () => _open(url), icon: const Icon(Icons.open_in_new_rounded, size: 18), label: const Text('Mở')),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: url));
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Đã sao chép.')));
                    },
                    icon: const Icon(Icons.copy_rounded, size: 18),
                    label: const Text('Sao chép'),
                  ),
                ]),
              ]),
            ),
            if (qr) QrImageView(data: url, size: 120, backgroundColor: Colors.white),
          ]),
        ),
      );

  Widget _overview(BuildContext context) {
    final running = s.web.current == ServiceState.running;
    final busy = s.db.current == ServiceState.starting || s.web.current == ServiceState.starting;
    final lic = s.license;
    return ListView(padding: const EdgeInsets.all(20), children: [
      if (lic != null && (!lic.allowed || lic.state == LicenseState.trial || (lic.state == LicenseState.licensed && lic.daysLeft <= 14)))
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Card(
            color: lic.allowed ? Colors.amber.shade50 : Colors.red.shade50,
            child: ListTile(
              leading: Icon(lic.allowed ? Icons.info_outline_rounded : Icons.lock_rounded, color: lic.allowed ? Colors.amber.shade800 : Colors.red.shade700),
              title: Text(lic.message),
              trailing: TextButton(onPressed: () => setState(() => _tab = 3), child: const Text('Mở Giấy phép')),
            ),
          ),
        ),
      Row(children: [
        FilledButton.icon(onPressed: busy || running || (lic != null && !lic.allowed) ? null : () => s.startAll(), icon: const Icon(Icons.play_arrow_rounded), label: const Text('Bật tất cả')),
        const SizedBox(width: 8),
        OutlinedButton.icon(onPressed: running ? () => s.restartWeb() : null, icon: const Icon(Icons.restart_alt_rounded), label: const Text('Khởi động lại máy chủ web')),
        const SizedBox(width: 8),
        OutlinedButton.icon(onPressed: s.db.isActive || s.web.isActive ? () => s.stopAll() : null, icon: const Icon(Icons.stop_rounded), label: const Text('Tắt tất cả')),
      ]),
      const SizedBox(height: 16),
      _service('Cơ sở dữ liệu (MariaDB)', 'Dữ liệu của quán nằm trên máy này, cổng ${s.config.dbPort} (chỉ máy này truy cập được)', s.db),
      const SizedBox(height: 8),
      _service('Máy chủ web (POS + quản trị + API cho app)', 'Cổng ${s.config.serverPort}', s.web),
      const SizedBox(height: 8),
      _service('ngrok (địa chỉ công khai)', s.tunnelNote ?? (s.config.ngrok.enabled ? 'Cho điện thoại ngoài quán truy cập' : 'Đang tắt'), s.tunnel),
      const SizedBox(height: 20),
      Text('Địa chỉ truy cập', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      _addr('Trên máy này', s.localUrl),
      for (final ip in _lan) ...[const SizedBox(height: 8), _addr('Trong cùng Wi-Fi/LAN (nhập vào app điện thoại)', 'http://$ip:${s.config.serverPort}')],
      if (s.publicUrl.isNotEmpty) ...[const SizedBox(height: 8), _addr('Công khai (từ bất kỳ đâu, cho app điện thoại và web)', s.publicUrl, qr: true)],
      const SizedBox(height: 16),
      if (running)
        Card(
          color: Colors.blue.shade50,
          child: ListTile(
            leading: const Icon(Icons.info_outline_rounded),
            title: const Text('Lần đầu dùng: mở trang quản trị để tạo tài khoản chủ quán'),
            subtitle: Text('Mã cài đặt: ${s.config.installToken} (nhập ở trang cài đặt để người khác không chiếm được)'),
            trailing: FilledButton(onPressed: () => _open('${s.localUrl}/cai-dat'), child: const Text('Mở trang cài đặt')),
          ),
        ),
    ]);
  }

  Widget _logs(BuildContext context) {
    final lines = s.allLog.reversed.take(300).toList();
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Card(
        child: ListView.builder(
          padding: const EdgeInsets.all(10),
          itemCount: lines.length,
          itemBuilder: (_, i) => SelectableText(lines[i], style: const TextStyle(fontFamily: 'Consolas', fontSize: 12.5)),
        ),
      ),
    );
  }
}
