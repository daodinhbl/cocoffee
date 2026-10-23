import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_mode.dart';
import '../nav.dart';
import '../session.dart';
import '../theme/app_theme.dart';
import '../update/app_update.dart';
import 'common.dart';
import 'offline_banner.dart';

/// Width from which the app shows the web's sidebar instead of the phone bottom bar.
const kSidebarBreakpoint = 840.0;

/// Opens a navigation item the way the web does: bottom-bar sections switch branch, other modules are pushed,
/// modules not built in the app yet open the Web Admin page in the browser.
Future<void> openNavItem(BuildContext context, WidgetRef ref, NavItem item, {StatefulNavigationShell? shell}) async {
  if (item.webPath != null) {
    final server = ref.read(serverUrlProvider);
    final ok = await launchUrl(Uri.parse('$server${item.webPath}'), mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) showToast(context, 'Không mở được trình duyệt.', error: true);
    return;
  }
  final branch = branchOf(item.route);
  if (branch != null && shell != null) {
    shell.goBranch(branch, initialLocation: branch == shell.currentIndex);
  } else if (branch != null) {
    context.go(item.route);
  } else {
    context.push(item.route);
  }
}

/// The sidebar / "Menu" page for [user]; in local mode only what the phone serves alone ([kLocalNavKeys]).
List<NavGroup> visibleGroups(AppUser? user, {bool local = false}) => [
      for (final g in navGroups)
        NavGroup(g.heading, [
          for (final i in g.items)
            if ((!i.adminOnly || (user?.isAdmin ?? false)) && (!local || kLocalNavKeys.contains(i.key))) i,
        ]),
    ].where((g) => g.items.isNotEmpty).toList();

/// Branch indexes of the bottom-bar tabs shown: all five on a server, without "Kho" in local mode.
List<int> visibleTabs({bool local = false}) => [
      for (var i = 0; i < bottomTabs.length; i++)
        if (!local || kLocalNavKeys.contains(bottomTabs[i].key)) i,
    ];

class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.shell});
  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wide = MediaQuery.sizeOf(context).width >= kSidebarBreakpoint;
    final tabs = visibleTabs(local: ref.watch(appModeProvider) == AppMode.local);
    final selected = tabs.indexOf(shell.currentIndex);
    if (wide) {
      return Scaffold(
        body: Row(children: [
          _Sidebar(shell: shell),
          Expanded(child: Column(children: [const UpdateBanner(), const OfflineBanner(), Expanded(child: shell)])),
        ]),
      );
    }
    return Scaffold(
      body: Column(children: [const UpdateBanner(), const OfflineBanner(), Expanded(child: shell)]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: selected < 0 ? 0 : selected,
        onDestinationSelected: (i) => shell.goBranch(tabs[i], initialLocation: tabs[i] == shell.currentIndex),
        destinations: [
          for (final i in tabs) NavigationDestination(icon: Icon(bottomTabs[i].icon), label: bottomTabs[i].label),
        ],
      ),
    );
  }
}

class _Sidebar extends ConsumerWidget {
  const _Sidebar({required this.shell});
  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final local = ref.watch(appModeProvider) == AppMode.local;
    final current = bottomTabs[shell.currentIndex].route;
    return Container(
      width: 248,
      color: context.co.sidebar,
      child: SafeArea(
        right: false,
        child: Column(children: [
          const _Brand(),
          Divider(color: Palette.navyLine, height: 1),
          Expanded(
            child: ListView(padding: const EdgeInsets.symmetric(vertical: 10), children: [
              for (final g in visibleGroups(user, local: local)) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 12, 16, 4),
                  child: Text(g.heading.toUpperCase(),
                      style: const TextStyle(color: Palette.navyMuted, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 0.8)),
                ),
                for (final item in g.items)
                  _SidebarTile(item: item, selected: item.route == current, onTap: () => openNavItem(context, ref, item, shell: shell)),
              ],
            ]),
          ),
          if (user != null) _UserFooter(user: user),
        ]),
      ),
    );
  }
}

class _Brand extends ConsumerWidget {
  const _Brand();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SizedBox(
      height: 64,
      child: Row(children: [
        const SizedBox(width: 20),
        Container(
          width: 36,
          height: 36,
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(6)),
          child: Image.asset('assets/brand/mark.png', fit: BoxFit.contain),
        ),
        const SizedBox(width: 12),
        const Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Tasotek FnB', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
          Text('Admin', style: TextStyle(color: Palette.navyMuted, fontSize: 12)),
        ]),
      ]),
    );
  }
}

class _SidebarTile extends StatelessWidget {
  const _SidebarTile({required this.item, required this.selected, required this.onTap});
  final NavItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Palette.navy : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 48,
          decoration: BoxDecoration(border: Border(left: BorderSide(color: selected ? Palette.amber : Colors.transparent, width: 3))),
          padding: const EdgeInsets.only(left: 21, right: 12),
          child: Row(children: [
            Icon(item.icon, size: 21, color: selected ? Palette.amber : Palette.navySoft),
            const SizedBox(width: 12),
            Expanded(
              child: Text(item.label,
                  style: TextStyle(color: selected ? Colors.white : Palette.navySoft, fontWeight: FontWeight.w500, fontSize: 14.5)),
            ),
            if (item.webPath != null) const Icon(Icons.open_in_new_rounded, size: 15, color: Palette.navyMuted),
          ]),
        ),
      ),
    );
  }
}

class _UserFooter extends ConsumerWidget {
  const _UserFooter({required this.user});
  final AppUser user;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Palette.navyLine))),
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Row(children: [
        CircleAvatar(radius: 16, backgroundColor: Palette.navy, child: Text(user.fullName.isEmpty ? '?' : user.fullName[0].toUpperCase(),
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700))),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(user.fullName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
            Text(user.roleLabel, style: const TextStyle(color: Palette.navyMuted, fontSize: 12)),
          ]),
        ),
        IconButton(
          tooltip: 'Đăng xuất',
          onPressed: () => ref.read(authProvider.notifier).logout(),
          icon: const Icon(Icons.logout_rounded, color: Palette.navySoft),
        ),
      ]),
    );
  }
}
