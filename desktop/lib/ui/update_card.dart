import 'dart:async';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../core/stack.dart';
import '../core/updater.dart';

/// "Cập nhật phần mềm": looks for a newer installer on the update server (at start, then every 6 hours, or on the button),
/// downloads and verifies it, then installs it silently. Shown at the top of the overview, quiet when up to date.
class UpdateCard extends StatefulWidget {
  const UpdateCard({super.key, required this.stack, this.updater, this.currentVersion});
  final StackController stack;

  /// Plug-ins for tests.
  final WindowsUpdater? updater;
  final String? currentVersion;

  @override
  State<UpdateCard> createState() => _UpdateCardState();
}

class _UpdateCardState extends State<UpdateCard> {
  Timer? _timer;
  String _current = '';
  WindowsRelease? _found;
  String? _message;
  bool _busy = false;
  double? _progress;

  WindowsUpdater get _updater => widget.updater ?? WindowsUpdater(server: widget.stack.config.updateServer);

  @override
  void initState() {
    super.initState();
    () async {
      _current = widget.currentVersion ?? (await PackageInfo.fromPlatform()).version;
      if (!mounted) return;
      setState(() {});
      if (widget.stack.config.autoUpdateCheck) unawaited(_check(quiet: true));
    }();
    _timer = Timer.periodic(const Duration(hours: 6), (_) {
      if (widget.stack.config.autoUpdateCheck && !_busy) _check(quiet: true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _check({bool quiet = false}) async {
    setState(() {
      _busy = true;
      if (!quiet) _message = null;
    });
    try {
      final rel = await _updater.check(_current);
      if (!mounted) return;
      setState(() {
        _found = rel;
        if (!quiet) _message = rel == null ? 'Bạn đang dùng bản mới nhất ($_current).' : null;
      });
    } on UpdateException catch (e) {
      if (mounted && !quiet) setState(() => _message = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _install() async {
    final rel = _found;
    if (rel == null) return;
    setState(() {
      _busy = true;
      _progress = 0;
      _message = null;
    });
    try {
      final file = await _updater.download(rel, onProgress: (v) => mounted ? setState(() => _progress = v) : null);
      if (!mounted) return;
      setState(() => _message = 'Đang cài bản ${rel.version}, chương trình sẽ tự mở lại…');
      await widget.stack.installUpdate(file);
    } on UpdateException catch (e) {
      if (mounted) setState(() => _message = e.message);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final rel = _found;
    if (rel == null && _message == null) {
      return Align(
        alignment: Alignment.centerRight,
        child: TextButton.icon(
          onPressed: _busy ? null : () => _check(),
          icon: const Icon(Icons.system_update_alt_rounded, size: 18),
          label: Text(_busy ? 'Đang kiểm tra…' : 'Kiểm tra cập nhật${_current.isEmpty ? '' : ' (đang dùng $_current)'}'),
        ),
      );
    }
    return Card(
      color: rel != null ? Colors.blue.shade50 : null,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(rel != null ? Icons.system_update_rounded : Icons.info_outline_rounded),
            const SizedBox(width: 10),
            Expanded(child: Text(rel != null ? 'Có bản mới ${rel.version} (đang dùng $_current)' : _message!, style: const TextStyle(fontWeight: FontWeight.w600))),
            if (rel != null)
              FilledButton.icon(key: const Key('install-update'), onPressed: _busy ? null : _install, icon: const Icon(Icons.download_rounded), label: const Text('Cập nhật ngay'))
            else
              TextButton(onPressed: _busy ? null : () => _check(), child: const Text('Kiểm tra lại')),
          ]),
          if (rel != null && _message != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_message!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          if (_progress != null) Padding(padding: const EdgeInsets.only(top: 10), child: LinearProgressIndicator(value: _progress)),
          if (rel != null && _progress == null) const Padding(padding: EdgeInsets.only(top: 6), child: Text('Dữ liệu và cài đặt được giữ nguyên. POS sẽ dừng vài chục giây trong lúc cập nhật.', style: TextStyle(fontSize: 12))),
        ]),
      ),
    );
  }
}
