import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/offline/connectivity.dart';
import '../../core/offline/offline_coordinator.dart';
import '../../core/offline/outbox.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';

/// "Đồng bộ ngoại tuyến": the server connection, the writes waiting to be replayed (retry / discard), what was
/// replayed recently, and the cached data. Reached from the banner, the POS menu and Menu → Hệ thống.
class SyncScreen extends ConsumerWidget {
  const SyncScreen({super.key});

  Future<void> _discard(BuildContext context, WidgetRef ref, OutboxItem item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Xóa ${item.title.toLowerCase()} ${item.code}?'),
        content: const Text('Thao tác này sẽ không được gửi lên máy chủ nữa. Không thể hoàn tác.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Giữ lại')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: ctx.co.bad),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Xóa'),
          ),
        ],
      ),
    );
    if (ok == true) await ref.read(outboxProvider.notifier).remove(item.id);
  }

  Future<void> _clearCache(BuildContext context, WidgetRef ref) async {
    final cache = ref.read(apiProvider).cache;
    if (cache == null) return;
    await cache.clear();
    refreshAllFrom(ref);
    if (context.mounted) showToast(context, 'Đã xóa dữ liệu đã lưu. Các màn hình sẽ tải lại từ máy chủ.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final net = ref.watch(netProvider);
    final box = ref.watch(outboxProvider);
    final items = [...box.items]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final cache = ref.watch(apiProvider).cache;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Đồng bộ ngoại tuyến'),
        actions: [
          IconButton(
            tooltip: 'Đồng bộ ngay',
            onPressed: box.syncing || box.pending.isEmpty ? null : () => ref.read(outboxProvider.notifier).sync(),
            icon: const Icon(Icons.sync_rounded),
          ),
        ],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(
          title: 'Kết nối máy chủ',
          child: Row(children: [
            Icon(net.online ? Icons.cloud_done_outlined : Icons.wifi_off_rounded, color: net.online ? context.co.good : context.co.warn),
            const SizedBox(width: 10),
            Expanded(
              child: Text(net.online
                  ? 'Đang kết nối với máy chủ.'
                  : 'Mất kết nối${net.since != null ? ' từ ${shopClock(net.since)}' : ''} · các màn hình đang dùng dữ liệu đã lưu.'),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              onPressed: net.checking ? null : () => ref.read(netProvider.notifier).probe(),
              child: Text(net.checking ? 'Đang kiểm tra…' : 'Kiểm tra'),
            ),
          ]),
        ),
        const SizedBox(height: 16),
        SectionCard(
          title: 'Chờ gửi lên máy chủ',
          trailing: box.syncing
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : (items.isEmpty
                  ? null
                  : Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: box.failedCount > 0 ? context.co.badTint : context.co.infoTint,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('${items.length}',
                          style: TextStyle(fontWeight: FontWeight.w700, color: box.failedCount > 0 ? context.co.bad : context.co.info)),
                    )),
          child: items.isEmpty
              ? const EmptyState(text: 'Không có thao tác nào chờ đồng bộ.', icon: Icons.cloud_done_outlined)
              : Column(children: [
                  for (var i = 0; i < items.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    _ItemTile(
                      item: items[i],
                      onRetry: items[i].failed && !box.syncing ? () => ref.read(outboxProvider.notifier).retry(items[i].id) : null,
                      onDiscard: box.syncing ? null : () => _discard(context, ref, items[i]),
                    ),
                  ],
                ]),
        ),
        const SizedBox(height: 16),
        SectionCard(
          title: 'Đã đồng bộ gần đây',
          trailing: box.synced.isEmpty
              ? null
              : TextButton(onPressed: () => ref.read(outboxProvider.notifier).clearSynced(), child: const Text('Xóa lịch sử')),
          child: box.synced.isEmpty
              ? const EmptyState(text: 'Chưa có thao tác nào được đồng bộ.', icon: Icons.history_rounded)
              : Column(children: [
                  for (var i = 0; i < box.synced.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.check_circle_outline_rounded, color: context.co.good),
                      title: Text('${_kindLabel(box.synced[i].kind)} ${box.synced[i].localCode} → ${box.synced[i].serverCode.isEmpty ? 'đã gửi' : box.synced[i].serverCode}'),
                      subtitle: Text(shopTime(box.synced[i].at)),
                    ),
                  ],
                ]),
        ),
        const SizedBox(height: 16),
        SectionCard(
          title: 'Dữ liệu đã lưu trên máy',
          child: Row(children: [
            Expanded(
              child: cache == null
                  ? const Text('Không có bộ nhớ đệm.')
                  : FutureBuilder<int>(
                      future: cache.count(),
                      builder: (_, snap) => Text(snap.hasData
                          ? '${snap.data} màn hình/dữ liệu được lưu để dùng khi mất kết nối.'
                          : 'Các màn hình đã mở được lưu để dùng khi mất kết nối.'),
                    ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: cache == null ? null : () => _clearCache(context, ref), child: const Text('Xóa')),
          ]),
        ),
      ]),
    );
  }
}

String _kindLabel(String kind) => switch (kind) { 'checkout' => 'Thanh toán', 'hold' => 'Giữ đơn', 'pay' => 'Thu tiền', _ => kind };

class _ItemTile extends StatelessWidget {
  const _ItemTile({required this.item, required this.onRetry, required this.onDiscard});
  final OutboxItem item;
  final VoidCallback? onRetry;
  final VoidCallback? onDiscard;

  @override
  Widget build(BuildContext context) {
    final where = '${item.local['table'] ?? 'Mang đi'}';
    final summary = '${item.local['summary'] ?? ''}';
    final icon = switch (item.kind) { 'checkout' => Icons.payments_outlined, 'hold' => Icons.table_restaurant_outlined, _ => Icons.point_of_sale_rounded };
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        backgroundColor: item.failed ? context.co.badTint : context.co.infoTint,
        child: Icon(icon, color: item.failed ? context.co.bad : context.co.info, size: 20),
      ),
      title: Text('${item.title} · ${item.code}', style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$where${summary.isNotEmpty ? ' · $summary' : ''}', maxLines: 2, overflow: TextOverflow.ellipsis),
        Text('${money(item.total)} · ${shopTime(item.createdAt)}${item.attempts > 0 ? ' · đã thử ${item.attempts} lần' : ''}', style: context.tt.bodySmall),
        if (item.failed) Text(item.error!, style: TextStyle(color: context.co.bad, fontSize: 12.5)),
      ]),
      isThreeLine: true,
      trailing: PopupMenuButton<String>(
        tooltip: 'Thao tác',
        onSelected: (v) => v == 'retry' ? onRetry?.call() : onDiscard?.call(),
        itemBuilder: (_) => [
          if (onRetry != null) const PopupMenuItem(value: 'retry', child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.refresh_rounded), title: Text('Thử lại'))),
          PopupMenuItem(
            value: 'discard',
            enabled: onDiscard != null,
            child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.delete_outline_rounded, color: context.co.bad), title: const Text('Xóa')),
          ),
        ],
      ),
    );
  }
}
