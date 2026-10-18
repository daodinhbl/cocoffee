import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/diagnostics/app_log.dart';
import 'core/session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = SessionStore(await SharedPreferences.getInstance());
  await store.load();
  // Offline data (cached answers, queued sales, the cart) lives in the app's private support directory.
  Directory? dir;
  try {
    dir = await getApplicationSupportDirectory();
  } catch (_) {
    dir = null; // no plugin (tests, unsupported platform): memory only
  }
  await AppLog.instance.install(dir);
  runApp(ProviderScope(
    overrides: [sessionStoreProvider.overrideWithValue(store), appDirProvider.overrideWithValue(dir)],
    child: const CoCoffeeApp(),
  ));
}
