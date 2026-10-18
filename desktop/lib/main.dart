import 'dart:io';

import 'package:flutter/material.dart';

import 'core/config.dart';
import 'core/stack.dart';
import 'ui/home_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final paths = InstallPaths.detect();
  final store = ConfigStore(paths);
  final config = store.loadOrCreate();
  final stack = StackController(paths: paths, store: store, config: config);
  runApp(ServerManagerApp(stack: stack));
  // Start everything at launch, like a service: the shop opens the box and the POS is there.
  if (config.autoStartServices && File(paths.node).existsSync()) {
    stack.startAll();
  }
}

class ServerManagerApp extends StatelessWidget {
  const ServerManagerApp({super.key, required this.stack});
  final StackController stack;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'POS Tasotek Server',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1E3A8A)),
        scaffoldBackgroundColor: const Color(0xFFFAF8F5),
        cardTheme: const CardThemeData(color: Colors.white, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10)), side: BorderSide(color: Color(0xFFE8E3DA)))),
      ),
      home: HomePage(stack: stack),
    );
  }
}
