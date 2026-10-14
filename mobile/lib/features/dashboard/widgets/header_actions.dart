import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../dashboard_models.dart';
import '../dashboard_providers.dart';

/// Zalo connection state from the web header: a dot on phones (< 600 dp), a pill with the label from 600 dp.
class ZaloStatusPill extends ConsumerWidget {
  const ZaloStatusPill({super.key});

  static Color dotColor(String state) => switch (state) {
        'ok' => const Color(0xFF22C55E),
        'warn' => Palette.amberPressed,
        _ => const Color(0xFF9CA3AF),
      };

  static Tone tone(String state) => switch (state) {
        'ok' => Tone.good,
        'warn' => Tone.warn,
        _ => Tone.neutral,
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(zaloStatusProvider);
    if (async.isLoading && !async.hasValue) return const SizedBox.shrink();
    final z = async.hasValue ? async.requireValue : ZaloStatus.unknown;
    final dot = Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: dotColor(z.state), shape: BoxShape.circle),
    );
    final phone = MediaQuery.sizeOf(context).width < 600;
    if (phone) {
      return Semantics(
        label: z.label,
        container: true,
        child: Tooltip(
          message: z.label,
          triggerMode: TooltipTriggerMode.tap,
          child: SizedBox(key: const ValueKey('zalo-dot'), width: 28, height: 40, child: Center(child: ExcludeSemantics(child: dot))),
        ),
      );
    }
    final t = tone(z.state);
    return Tooltip(
      message: 'Trạng thái kết nối Zalo OA',
      child: Container(
        key: const ValueKey('zalo-pill'),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: t.bg(context),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: t.fg(context).withValues(alpha: 0.25)),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          SizedBox(width: 8, height: 8, child: dot),
          const SizedBox(width: 8),
          Text(z.label, style: TextStyle(color: t.fg(context), fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.25)),
        ]),
      ),
    );
  }
}

/// Bell with an amber count badge; opens the "Thông báo" sheet (admins only).
class NotificationsBell extends ConsumerWidget {
  const NotificationsBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(notificationsProvider);
    final notes = async.hasValue ? buildNotes(async.requireValue) : const <NoteRow>[];
    final n = notes.length;
    return IconButton(
      key: const ValueKey('notif-bell'),
      tooltip: 'Thông báo ($n)',
      onPressed: () {
        ref.invalidate(notificationsProvider); // fresh list each time, like the web loads it per page
        showNotificationsSheet(context);
      },
      icon: Badge(
        isLabelVisible: n > 0,
        backgroundColor: Palette.amber,
        textColor: Palette.ink900,
        label: Text('$n', style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: tabular)),
        child: const Icon(Icons.notifications_none_rounded),
      ),
    );
  }
}

/// Bottom sheet listing the notifications; a row closes the sheet and opens its screen.
Future<void> showNotificationsSheet(BuildContext context) {
  final host = context;
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    builder: (sheet) => _NotificationsSheet(
      onOpen: (row) {
        Navigator.of(sheet).pop();
        if (!host.mounted) return;
        if (row.target == NoteTarget.push) {
          host.push(row.location);
        } else {
          host.go(row.location);
        }
      },
    ),
  );
}

class _NotificationsSheet extends ConsumerWidget {
  const _NotificationsSheet({required this.onOpen});
  final void Function(NoteRow row) onOpen;

  Color _dot(BuildContext context, Tone tone) => switch (tone) {
        Tone.bad => const Color(0xFFEF4444),
        Tone.info => const Color(0xFF0EA5E9),
        Tone.warn => Palette.amberPressed,
        _ => const Color(0xFF9CA3AF),
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(notificationsProvider);
    final maxH = MediaQuery.sizeOf(context).height * 0.7;
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
            child: Text('Thông báo', style: context.tt.titleMedium),
          ),
          const Divider(),
          Flexible(
            child: AsyncBody<NotificationsData>(
              value: async,
              onRetry: () => ref.invalidate(notificationsProvider),
              data: (d) {
                final notes = buildNotes(d);
                if (notes.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 20),
                    child: Text('Không có thông báo mới.',
                        textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
                  );
                }
                return ListView.separated(
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: 12),
                  itemCount: notes.length,
                  separatorBuilder: (_, _) => const Divider(indent: 20, endIndent: 20),
                  itemBuilder: (_, i) {
                    final row = notes[i];
                    return InkWell(
                      onTap: () => onOpen(row),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 7),
                            child: Container(
                                width: 8, height: 8, decoration: BoxDecoration(color: _dot(context, row.tone), shape: BoxShape.circle)),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(row.text, style: context.tt.bodyMedium),
                              if (row.time != null) Text(row.time!, style: context.tt.bodySmall),
                            ]),
                          ),
                          Icon(Icons.chevron_right_rounded, size: 20, color: context.co.muted),
                        ]),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ]),
      ),
    );
  }
}
