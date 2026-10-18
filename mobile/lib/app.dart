import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/notify/new_order_watcher.dart';
import 'core/offline/connectivity.dart';
import 'core/update/app_update.dart';
import 'core/offline/offline_coordinator.dart';
import 'core/offline/outbox.dart';
import 'core/offline/snapshot_sync.dart';
import 'core/router.dart';
import 'core/security/app_lock.dart';
import 'core/session.dart';
import 'core/theme/app_theme.dart';

class CoCoffeeApp extends ConsumerStatefulWidget {
  const CoCoffeeApp({super.key});

  @override
  ConsumerState<CoCoffeeApp> createState() => _CoCoffeeAppState();
}

class _CoCoffeeAppState extends ConsumerState<CoCoffeeApp> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // Back in the foreground: find out whether the server is reachable and replay what waited meanwhile.
    _lifecycle = AppLifecycleListener(onHide: () => ref.read(appLockProvider.notifier).leftApp(), onResume: () {
      ref.read(appLockProvider.notifier).returned();
      ref.read(netProvider.notifier).probe();
      ref.read(outboxProvider.notifier).sync();
      ref.read(snapshotSyncProvider.notifier).sync();
    });
    // A stored session: re-read the account (GET /api/auth/me), since the role, the name or the "must change
    // password" flag may have changed in the Web Admin. A dead token answers 401 and the API client signs out;
    // offline, the cached account is kept.
    if (ref.read(authProvider) is SignedIn) {
      ref.read(authProvider.notifier).refreshMe().catchError((Object _) {});
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(updateWatcherProvider); // a newer APK on the server: banner + one notification per build
    ref.watch(newOrderWatcherProvider); // admin signed in: notify when a customer confirms a Zalo order
    ref.watch(offlineCoordinatorProvider); // reconnect -> replay the outbox, refresh the open screens
    return MaterialApp.router(
      title: 'Tasotek FnB',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.light, // the Web Admin is light-only; dark tokens are ready for a later toggle
      locale: const Locale('vi'),
      supportedLocales: const [Locale('vi'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => Stack(children: [
        child ?? const SizedBox.shrink(),
        if (ref.watch(appLockProvider).locked && ref.watch(authProvider) is SignedIn) const Positioned.fill(child: LockScreen()),
      ]),
    );
  }
}
