import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/sync/sync_screen.dart';
import '../offline/connectivity.dart';
import '../offline/outbox.dart';
import '../theme/app_theme.dart';

/// Opens the sync screen: through the router when there is one, else pushed directly (tests, dialogs).
void openSyncScreen(BuildContext context) {
  final router = GoRouter.maybeOf(context);
  if (router != null) {
    router.push('/sync');
  } else {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SyncScreen()));
  }
}

/// One line under the app bar that says what the offline machinery is doing. Nothing is shown while the server
/// answers and no write waits:
///  - offline: "Mất kết nối máy chủ · đang dùng dữ liệu đã lưu", with the number of queued writes and Thử lại;
///  - replaying: "Đang đồng bộ N thao tác…";
///  - a replay the server refused: "N thao tác đồng bộ lỗi" (red) with Xem;
///  - queued writes while online (a sync is about to run, or was interrupted): "N thao tác chờ đồng bộ" with Đồng bộ ngay.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final net = ref.watch(netProvider);
    final box = ref.watch(outboxProvider);
    final pending = box.pending.length;
    final failed = box.failedCount;
    if (net.online && box.isEmpty && !box.syncing) return const SizedBox.shrink();

    late final IconData icon;
    late final String text;
    late final Color bg;
    late final Color fg;
    final actions = <Widget>[];
    Widget action(String label, VoidCallback? onTap) => TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(foregroundColor: fg, visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 10)),
          child: Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
        );

    if (!net.online) {
      icon = Icons.wifi_off_rounded;
      text = 'Mất kết nối máy chủ · đang dùng dữ liệu đã lưu${pending > 0 ? ' · $pending thao tác chờ' : ''}';
      bg = context.co.warnTint;
      fg = context.co.warn;
      actions.add(net.checking
          ? const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)))
          : action('Thử lại', () => ref.read(netProvider.notifier).probe()));
      if (!box.isEmpty) actions.add(action('Xem', () => openSyncScreen(context)));
    } else if (box.syncing) {
      icon = Icons.sync_rounded;
      text = 'Đang đồng bộ $pending thao tác…';
      bg = context.co.infoTint;
      fg = context.co.info;
    } else if (failed > 0) {
      icon = Icons.error_outline_rounded;
      text = '$failed thao tác đồng bộ lỗi${pending > 0 ? ' · $pending đang chờ' : ''}';
      bg = context.co.badTint;
      fg = context.co.bad;
      actions.add(action('Xem', () => openSyncScreen(context)));
    } else {
      icon = Icons.cloud_upload_outlined;
      text = '$pending thao tác chờ đồng bộ';
      bg = context.co.infoTint;
      fg = context.co.info;
      actions.add(action('Đồng bộ ngay', () => ref.read(outboxProvider.notifier).sync()));
      actions.add(action('Xem', () => openSyncScreen(context)));
    }

    return Material(
      color: bg,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
        child: Row(children: [
          Icon(icon, size: 18, color: fg),
          const SizedBox(width: 8),
          Expanded(child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontSize: 13, fontWeight: FontWeight.w600))),
          ...actions,
        ]),
      ),
    );
  }
}
