import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = SessionStore(await SharedPreferences.getInstance());
  await store.load();
  runApp(ProviderScope(
    overrides: [sessionStoreProvider.overrideWithValue(store)],
    child: const CoCoffeeApp(),
  ));
}
