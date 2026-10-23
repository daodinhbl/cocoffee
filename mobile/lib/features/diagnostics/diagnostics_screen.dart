import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/diagnostics/app_log.dart';
import '../../core/format.dart';
import '../../core/offline/connectivity.dart';
import '../../core/offline/outbox.dart';
import '../../core/offline/snapshot_sync.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/update/app_update.dart';
import '../../core/widgets/common.dart';
import '../settings/settings_models.dart';

/// "Chẩn đoán": what the phone knows about itself (version, server, connection, waiting writes, offline copy) and the last
/// errors it recorded. Copy or share it when something goes wrong; nothing leaves the phone unless you send it.
class DiagnosticsScreen extends ConsumerStatefulWidget {
  const DiagnosticsScreen({super.key});
  @override
  ConsumerState<DiagnosticsScreen> createState() => _DiagnosticsScreenState();
}

class _DiagnosticsScreenState extends ConsumerState<DiagnosticsScreen> {
  final _log = AppLog.instance;

  @override
  void initState() {
    super.initState();
    _log.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _log.removeListener(_changed);
    super.dispose();
  }

  List<MapEntry<String, String>> _facts() {
    final user = ref.watch(currentUserProvider);
    final net = ref.watch(netProvider);
    final box = ref.watch(outboxProvider);
    final snap = ref.watch(snapshotSyncProvider);
    return [
      MapEntry('Phiên bản', '$kAppVersion${kPlayStore ? ' · Google Play' : ''}'),
      MapEntry('Hệ điều hành', '${Platform.operatingSystem} ${Platform.operatingSystemVersion}'),
      MapEntry('Máy chủ', ref.watch(serverUrlProvider).replaceFirst(RegExp(r'^https?://'), '')),
      MapEntry('Tài khoản', user == null ? '—' : '${user.username} (${user.roleLabel})'),
      MapEntry('Kết nối', net.online ? 'Có mạng' : 'Mất mạng'),
      MapEntry('Thao tác chờ gửi', '${box.pending.length} chờ · ${box.failedCount} bị từ chối'),
      MapEntry('Bản sao ngoại tuyến', snap.at == null ? 'chưa có' : shopTime(snap.at)),
      if (snap.error != null) MapEntry('Lỗi đồng bộ gần nhất', snap.error!),
    ];
  }

  String _report() => 'Chẩn đoán POS Tasotek\n${_facts().map((e) => '${e.key}: ${e.value}').join('\n')}\n\nNhật ký:\n${_log.dump()}';

  @override
  Widget build(BuildContext context) {
    final facts = _facts();
    final entries = _log.entries;
    return Scaffold(
      appBar: AppBar(title: const Text('Chẩn đoán'), actions: [
        IconButton(
          tooltip: 'Sao chép',
          icon: const Icon(Icons.copy_rounded),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: _report()));
            if (context.mounted) showToast(context, 'Đã sao chép báo cáo chẩn đoán.');
          },
        ),
        IconButton(
          tooltip: 'Chia sẻ',
          icon: const Icon(Icons.ios_share_rounded),
          onPressed: () => SharePlus.instance.share(ShareParams(text: _report(), subject: 'Chẩn đoán POS Tasotek')),
        ),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
        SectionCard(
          title: 'Thông tin máy',
          child: Column(children: [
            for (final f in facts)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 130, child: Text(f.key, style: context.tt.bodySmall)),
                  Expanded(child: SelectableText(f.value)),
                ]),
              ),
          ]),
        ),
        const SizedBox(height: 12),
        SectionCard(
          title: 'Nhật ký lỗi (${entries.length})',
          trailing: TextButton(onPressed: entries.isEmpty ? null : _log.clear, child: const Text('Xóa')),
          child: entries.isEmpty
              ? Text('Chưa có lỗi nào được ghi lại.', style: context.tt.bodyMedium)
              : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  for (final e in entries.take(60))
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: SelectableText(
                        '${shopTime(e.at)}  ${e.message}',
                        style: TextStyle(fontSize: 12.5, color: e.level == 'error' ? context.co.bad : null),
                      ),
                    ),
                ]),
        ),
      ]),
    );
  }
}
