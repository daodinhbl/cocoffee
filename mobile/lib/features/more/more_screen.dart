import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_shell.dart';

/// "Menu" tab on phones: the web sidebar as a page (same groups and items), plus the account.
class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final server = ref.watch(serverUrlProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Menu')),
      body: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        if (user != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Card(
              child: ListTile(
                leading: CircleAvatar(
                  backgroundColor: Palette.navy,
                  child: Text(user.fullName.isEmpty ? '?' : user.fullName[0].toUpperCase(),
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                ),
                title: Text(user.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${user.username} · ${user.roleLabel}'),
              ),
            ),
          ),
        for (final g in visibleGroups(user)) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 16, 6),
            child: Text(g.heading.toUpperCase(), style: context.tt.labelSmall),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Card(
              child: Column(children: [
                for (var i = 0; i < g.items.length; i++) ...[
                  if (i > 0) const Divider(indent: 56),
                  ListTile(
                    leading: Icon(g.items[i].icon, color: context.cs.primary),
                    title: Text(g.items[i].label),
                    trailing: Icon(g.items[i].webPath != null ? Icons.open_in_new_rounded : Icons.chevron_right_rounded, size: 20),
                    onTap: () => openNavItem(context, ref, g.items[i]),
                  ),
                ],
              ]),
            ),
          ),
        ],
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 22, 16, 0),
          child: OutlinedButton.icon(
            onPressed: () => ref.read(authProvider.notifier).logout(),
            icon: Icon(Icons.logout_rounded, color: context.co.bad),
            label: Text('Đăng xuất', style: TextStyle(color: context.co.bad)),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text('Máy chủ: ${server.replaceFirst(RegExp(r'^https?://'), '')}', textAlign: TextAlign.center, style: context.tt.bodySmall),
        ),
      ]),
    );
  }
}
