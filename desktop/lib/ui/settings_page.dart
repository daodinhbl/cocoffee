import 'dart:io';

import 'package:flutter/material.dart';

import '../core/config.dart';
import '../core/ngrok.dart';
import '../core/stack.dart';

/// Registers / removes "start with Windows" (HKCU\...\Run): the shop box starts its services when the PC signs in.
Future<bool> setStartWithWindows(bool on, {String? exe}) async {
  try {
    const key = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
    if (on) {
      final r = await Process.run('reg', ['add', key, '/v', 'TasotekPOSServer', '/t', 'REG_SZ', '/d', '"${exe ?? Platform.resolvedExecutable}"', '/f']);
      return r.exitCode == 0;
    }
    await Process.run('reg', ['delete', key, '/v', 'TasotekPOSServer', '/f']);
    return true;
  } catch (_) {
    return false;
  }
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.stack});
  final StackController stack;
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  AppConfig get c => widget.stack.config;
  late final _shop = TextEditingController(text: c.shopName);
  late final _port = TextEditingController(text: '${c.serverPort}');
  late final _token = TextEditingController(text: c.ngrok.authToken);
  late final _api = TextEditingController(text: c.ngrok.apiKey);
  late final _domain = TextEditingController(text: c.ngrok.domain);
  bool _showSecrets = false;
  bool _busy = false;
  bool _autostart = false;
  String? _note;

  @override
  void dispose() {
    for (final t in [_shop, _port, _token, _api, _domain]) {
      t.dispose();
    }
    super.dispose();
  }

  void _say(String m) => setState(() => _note = m);

  Future<void> _save({bool restart = false}) async {
    final port = int.tryParse(_port.text.trim());
    if (port == null || port < 1024 || port > 65535 || port == c.dbPort) {
      _say('Cổng máy chủ web phải từ 1024 đến 65535 và khác cổng cơ sở dữ liệu (${c.dbPort}).');
      return;
    }
    final domain = _domain.text.trim().replaceFirst(RegExp(r'^https?://'), '').replaceAll(RegExp(r'/+$'), '');
    if (domain.isNotEmpty && !RegExp(r'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$', caseSensitive: false).hasMatch(domain)) {
      _say('Tên miền ngrok không hợp lệ (ví dụ quan-cua-toi.ngrok-free.app).');
      return;
    }
    c.shopName = _shop.text.trim().isEmpty ? c.shopName : _shop.text.trim();
    c.serverPort = port;
    c.ngrok
      ..authToken = _token.text.trim()
      ..apiKey = _api.text.trim()
      ..domain = domain;
    widget.stack.store.save(c);
    _say('Đã lưu.');
    if (restart) {
      setState(() => _busy = true);
      await widget.stack.stopAll();
      await widget.stack.startAll();
      if (mounted) setState(() => _busy = false);
      _say('Đã lưu và khởi động lại các dịch vụ.');
    }
  }

  Future<void> _autoDomain() async {
    setState(() => _busy = true);
    try {
      if (_api.text.trim().isEmpty) {
        // No API key of the shop's own: the vendor's broker issues a domain and a token bound to it (needs the licence).
        final got = await claimBrokerDomain(
          server: c.updateServer,
          machineId: widget.stack.machineId ?? '',
          licenseCode: c.licenseCode,
          shopName: _shop.text.trim().isEmpty ? c.shopName : _shop.text.trim(),
        );
        _domain.text = got.domain;
        _token.text = got.authtoken;
        _say('Đã lấy tên miền ${got.domain} và mã tunnel. Bấm "Lưu và áp dụng" để dùng.');
        if (mounted) setState(() => _busy = false);
        return;
      }
      final d = await pickDomain(NgrokApi(_api.text.trim()), current: _domain.text.trim(), shopName: _shop.text.trim().isEmpty ? c.shopName : _shop.text.trim());
      _domain.text = d;
      _say('Đã lấy tên miền: $d. Bấm "Lưu và áp dụng" để dùng.');
    } on NgrokException catch (e) {
      _say(e.message);
    } catch (e) {
      _say('Không gọi được ngrok: $e');
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Quán', style: t.titleMedium),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: TextField(controller: _shop, decoration: const InputDecoration(labelText: 'Tên quán'))),
        const SizedBox(width: 12),
        SizedBox(width: 160, child: TextField(controller: _port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Cổng máy chủ web'))),
      ]),
      const SizedBox(height: 8),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Tự bật các dịch vụ khi mở chương trình'),
        value: c.autoStartServices,
        onChanged: (v) => setState(() => c.autoStartServices = v),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Mở chương trình cùng Windows'),
        subtitle: const Text('Máy tính của quán tự chạy POS khi bật máy'),
        value: _autostart,
        onChanged: (v) async {
          final ok = await setStartWithWindows(v);
          if (ok) {
            setState(() => _autostart = v);
          } else {
            _say('Không đổi được cài đặt khởi động cùng Windows.');
          }
        },
      ),
      const Divider(height: 32),
      Text('Địa chỉ công khai (ngrok)', style: t.titleMedium),
      const SizedBox(height: 4),
      Text(
        'Để điện thoại ngoài quán và trang web vào được POS. Cần tài khoản ngrok (miễn phí): lấy Authtoken ở dashboard.ngrok.com > Your Authtoken. '
        'Chưa có tài khoản ngrok? Bấm "Tự lấy tên miền" khi để trống API key: máy có giấy phép sẽ được cấp tên miền và mã tunnel riêng. '
        'Nếu có API key ngrok của riêng bạn, nhập vào để chương trình tự tìm hoặc đăng ký tên miền cố định.',
        style: t.bodySmall,
      ),
      const SizedBox(height: 8),
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Bật ngrok'), value: c.ngrok.enabled, onChanged: (v) => setState(() => c.ngrok.enabled = v)),
      TextField(controller: _token, obscureText: !_showSecrets, decoration: const InputDecoration(labelText: 'ngrok Authtoken'), autocorrect: false),
      const SizedBox(height: 8),
      TextField(controller: _api, obscureText: !_showSecrets, decoration: const InputDecoration(labelText: 'ngrok API key (tùy chọn)'), autocorrect: false),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: TextField(controller: _domain, decoration: const InputDecoration(labelText: 'Tên miền cố định', hintText: 'quan-cua-toi.ngrok-free.app'), autocorrect: false)),
        const SizedBox(width: 8),
        OutlinedButton.icon(onPressed: _busy ? null : _autoDomain, icon: const Icon(Icons.auto_fix_high_rounded), label: const Text('Tự lấy tên miền')),
      ]),
      CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, title: const Text('Hiện token'), value: _showSecrets, onChanged: (v) => setState(() => _showSecrets = v ?? false)),
      const SizedBox(height: 12),
      Row(children: [
        FilledButton.icon(onPressed: _busy ? null : () => _save(restart: true), icon: const Icon(Icons.save_rounded), label: const Text('Lưu và áp dụng')),
        const SizedBox(width: 8),
        OutlinedButton(onPressed: _busy ? null : _save, child: const Text('Chỉ lưu')),
      ]),
      if (_note != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_note!, style: TextStyle(color: Theme.of(context).colorScheme.primary))),
      const SizedBox(height: 24),
      Text('Dữ liệu và sao lưu nằm ở: ${widget.stack.paths.dataDir}', style: t.bodySmall),
    ]);
  }
}
