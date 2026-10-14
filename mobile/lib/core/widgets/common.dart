import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme/app_theme.dart';

/// Badge tones used across the web (badge(text, tone) in src/utils/viewHelpers.js).
enum Tone { good, warn, bad, info, neutral }

extension ToneColors on Tone {
  Color fg(BuildContext c) => switch (this) {
        Tone.good => c.co.good,
        Tone.warn => c.co.warn,
        Tone.bad => c.co.bad,
        Tone.info => c.co.info,
        Tone.neutral => c.co.neutral,
      };
  Color bg(BuildContext c) => switch (this) {
        Tone.good => c.co.goodTint,
        Tone.warn => c.co.warnTint,
        Tone.bad => c.co.badTint,
        Tone.info => c.co.infoTint,
        Tone.neutral => c.co.neutralTint,
      };
}

Tone toneFrom(String? s) => switch (s) {
      'good' => Tone.good,
      'warn' => Tone.warn,
      'bad' => Tone.bad,
      'info' => Tone.info,
      _ => Tone.neutral,
    };

/// Small status pill: text + tone; state is never colour-alone (always a word).
class StatusBadge extends StatelessWidget {
  const StatusBadge(this.text, {super.key, this.tone = Tone.neutral, this.dense = false});
  final String text;
  final Tone tone;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 7 : 9, vertical: dense ? 1 : 3),
      decoration: BoxDecoration(color: tone.bg(context), borderRadius: BorderRadius.circular(999)),
      child: Text(text,
          style: TextStyle(color: tone.fg(context), fontSize: dense ? 11.5 : 12.5, fontWeight: FontWeight.w600, height: 1.3)),
    );
  }
}

/// Page title block like the web's H1 + description + actions.
class PageHeader extends StatelessWidget {
  const PageHeader({super.key, required this.title, this.subtitle, this.actions = const []});
  final String title;
  final String? subtitle;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w600, color: context.cs.onSurface)),
            if (subtitle != null) ...[
              const SizedBox(height: 4),
              Text(subtitle!, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
            ],
          ]),
        ),
        ...actions,
      ]),
    );
  }
}

/// Summary tile: uppercase label, big tabular number, sub-text, tinted icon; tappable when [onTap] is set.
class StatCard extends StatelessWidget {
  const StatCard({super.key, required this.label, required this.value, this.sub, this.icon, this.tone, this.onTap, this.valueColor, this.footer});
  final String label;
  final String value;
  final String? sub;
  final IconData? icon;
  final Tone? tone;
  final VoidCallback? onTap;
  final Color? valueColor;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final t = tone ?? Tone.neutral;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Text(label.toUpperCase(), style: context.tt.labelSmall, maxLines: 2)),
              if (icon != null)
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(color: t.bg(context), borderRadius: BorderRadius.circular(9)),
                  child: Icon(icon, size: 19, color: tone == null ? context.cs.primary : t.fg(context)),
                ),
            ]),
            const SizedBox(height: 4),
            Text(value,
                style: context.tt.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w700, fontFeatures: tabular, color: valueColor ?? context.cs.onSurface)),
            if (sub != null) ...[
              const SizedBox(height: 2),
              Text(sub!, style: context.tt.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
            if (footer != null) ...[const SizedBox(height: 8), footer!],
          ]),
        ),
      ),
    );
  }
}

/// Horizontal scroller on phones, grid on wide screens (the web's "swipe on phone, grid from sm up").
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.children, this.minTileWidth = 170});
  final List<Widget> children;
  final double minTileWidth;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      if (c.maxWidth < 600) {
        return SizedBox(
          height: 148,
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            scrollDirection: Axis.horizontal,
            itemCount: children.length,
            separatorBuilder: (_, _) => const SizedBox(width: 10),
            itemBuilder: (_, i) => SizedBox(width: c.maxWidth * 0.62, child: children[i]),
          ),
        );
      }
      final cols = (c.maxWidth / (minTileWidth + 12)).floor().clamp(2, children.length);
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [for (final w in children) SizedBox(width: (c.maxWidth - 32 - 12 * (cols - 1)) / cols, child: w)],
        ),
      );
    });
  }
}

/// Filter pill with a count, like the web's rounded "Tất cả 12 · Sắp hết 3".
class CountPill extends StatelessWidget {
  const CountPill({super.key, required this.label, this.count, required this.selected, required this.onTap, this.countTone});
  final String label;
  final int? count;
  final bool selected;
  final VoidCallback onTap;
  final Tone? countTone;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? Colors.white : context.cs.onSurface;
    return Material(
      color: selected ? Palette.navy : context.cs.surface,
      shape: StadiumBorder(side: BorderSide(color: selected ? Palette.navy : context.co.line)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w600, fontSize: 14)),
            if (count != null) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: selected ? Colors.white.withValues(alpha: 0.18) : (countTone?.bg(context) ?? context.co.neutralTint),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text('$count',
                    style: TextStyle(
                        fontFeatures: tabular,
                        fontSize: 12,
                        color: selected ? Colors.white : (countTone?.fg(context) ?? context.co.muted),
                        fontWeight: FontWeight.w600)),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Card with a title row, optional subtitle and trailing action, then content.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.title, this.subtitle, this.trailing, required this.child, this.padding = const EdgeInsets.all(16)});
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: padding,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: context.tt.titleMedium?.copyWith(color: context.cs.onSurface)),
                if (subtitle != null) Text(subtitle!, style: context.tt.bodySmall),
              ]),
            ),
            ?trailing,
          ]),
          const SizedBox(height: 12),
          child,
        ]),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.text, this.icon = Icons.inbox_outlined, this.action});
  final String text;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 40, color: context.co.muted),
        const SizedBox(height: 10),
        Text(text, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
        if (action != null) ...[const SizedBox(height: 12), action!],
      ]),
    );
  }
}

/// Error panel with a retry button; the message is already Vietnamese (ApiException).
class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, required this.error, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final e = toApiException(error);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(e.isOffline ? Icons.wifi_off_rounded : Icons.error_outline_rounded, size: 40, color: context.co.bad),
          const SizedBox(height: 10),
          Text(e.message, textAlign: TextAlign.center, style: context.tt.bodyMedium),
          if (onRetry != null) ...[
            const SizedBox(height: 14),
            OutlinedButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh_rounded), label: const Text('Thử lại')),
          ],
        ]),
      ),
    );
  }
}

/// Renders an AsyncValue: spinner, error with retry, or [data].
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({super.key, required this.value, required this.data, this.onRetry});
  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: data,
      loading: () => const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),
      error: (e, _) => ErrorPanel(error: e, onRetry: onRetry),
      skipLoadingOnRefresh: true,
      skipLoadingOnReload: true,
    );
  }
}

/// Photo from the server (/media/..., /menu/...) or the initial on a milk tile, like the web tables.
class Thumb extends ConsumerWidget {
  const Thumb({super.key, this.url, required this.name, this.size = 40});
  final String? url;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final server = ref.watch(serverUrlProvider);
    final radius = BorderRadius.circular(size * 0.22);
    final placeholder = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: context.co.neutralTint, borderRadius: radius),
      child: Text(initial(name), style: TextStyle(fontWeight: FontWeight.w700, color: context.cs.primary, fontSize: size * 0.38)),
    );
    final u = url;
    if (u == null || u.isEmpty) return placeholder;
    final full = u.startsWith('http') ? u : '$server$u';
    return ClipRRect(
      borderRadius: radius,
      child: Image.network(full, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => placeholder),
    );
  }
}

/// Stock level bar (full at 3x the minimum) — same rule as stockLevel() on the web.
class LevelBar extends StatelessWidget {
  const LevelBar({super.key, required this.fraction, required this.color, this.markAt});
  final double fraction;
  final Color color;
  final double? markAt;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 8,
      child: LayoutBuilder(builder: (context, c) {
        return Stack(clipBehavior: Clip.none, children: [
          Container(decoration: BoxDecoration(color: context.co.neutralTint, borderRadius: BorderRadius.circular(4))),
          Container(
            width: c.maxWidth * fraction.clamp(0, 1),
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
          ),
          if (markAt != null)
            Positioned(left: c.maxWidth * markAt! - 1, top: -3, child: Container(width: 2, height: 14, color: context.co.neutral)),
        ]);
      }),
    );
  }
}

void showToast(BuildContext context, String message, {bool error = false}) {
  final m = ScaffoldMessenger.maybeOf(context);
  m?.hideCurrentSnackBar();
  m?.showSnackBar(SnackBar(
    content: Text(message),
    backgroundColor: error ? context.co.bad : null,
  ));
}

/// Runs [action], shows its error as a toast, returns true on success.
Future<bool> runWithToast(BuildContext context, Future<void> Function() action, {String? success}) async {
  try {
    await action();
    if (context.mounted && success != null) showToast(context, success);
    return true;
  } catch (e) {
    if (context.mounted) showToast(context, toApiException(e).message, error: true);
    return false;
  }
}

/// Screens that are not built yet in the app open the Web Admin page instead.
class PlaceholderScreen extends StatelessWidget {
  const PlaceholderScreen({super.key, required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: const EmptyState(text: 'Màn hình này đang được xây dựng.', icon: Icons.construction_rounded),
    );
  }
}
