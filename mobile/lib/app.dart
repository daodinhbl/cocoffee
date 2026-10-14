import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router.dart';
import 'core/session.dart';
import 'core/theme/app_theme.dart';

class CoCoffeeApp extends ConsumerStatefulWidget {
  const CoCoffeeApp({super.key});

  @override
  ConsumerState<CoCoffeeApp> createState() => _CoCoffeeAppState();
}

class _CoCoffeeAppState extends ConsumerState<CoCoffeeApp> {
  @override
  void initState() {
    super.initState();
    // A stored session: re-read the account (GET /api/auth/me), since the role, the name or the "must change
    // password" flag may have changed in the Web Admin. A dead token answers 401 and the API client signs out;
    // offline, the cached account is kept.
    if (ref.read(authProvider) is SignedIn) {
      ref.read(authProvider.notifier).refreshMe().catchError((Object _) {});
    }
  }

  @override
  Widget build(BuildContext context) {
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
    );
  }
}
