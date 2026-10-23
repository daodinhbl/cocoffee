import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'session.dart';

/// How this phone is used, chosen on the welcome screen the first time the app opens:
///  - [unset]: nothing chosen yet (new install): the welcome screen with its three choices;
///  - [server]: staff of a shop on a server (an existing shop, or one just created with "Tạo quán mới");
///  - [local]: "Dùng trên máy này": the shop's data lives only in a SQLite file on the phone (core/local/).
enum AppMode { unset, server, local }

const _kMode = 'app_mode';

/// Set once the local shop was created (core/local/local_db.dart); cleared with "Xóa toàn bộ dữ liệu trên máy".
const kLocalReady = 'local_ready';

/// Address the app uses for itself in local mode: keeps the cart, caches and links of the local shop apart from
/// any server account. Never reached over the network.
const kLocalServer = 'local://may-nay';

/// The stored mode. Installs from before the welcome screen existed (a token, a signed-in user or a chosen server)
/// are server installs and never see the welcome screen.
AppMode readAppMode(SessionStore store) {
  final p = store.prefs;
  switch (p.getString(_kMode)) {
    case 'server':
      return AppMode.server;
    case 'local':
      return AppMode.local;
  }
  final usedBefore = store.token != null || store.cachedUser != null || p.getString('server_url') != null;
  return usedBefore ? AppMode.server : AppMode.unset;
}

final appModeProvider = NotifierProvider<AppModeNotifier, AppMode>(AppModeNotifier.new);

class AppModeNotifier extends Notifier<AppMode> {
  @override
  AppMode build() => readAppMode(ref.read(sessionStoreProvider));

  Future<void> set(AppMode mode) async {
    final prefs = ref.read(sessionStoreProvider).prefs;
    if (mode == AppMode.unset) {
      await prefs.remove(_kMode);
    } else {
      await prefs.setString(_kMode, mode.name);
    }
    state = mode;
  }
}

/// Is there a local shop on this phone? (Read by the router: local mode without one goes to the setup screen.)
final localReadyProvider = NotifierProvider<LocalReadyNotifier, bool>(LocalReadyNotifier.new);

class LocalReadyNotifier extends Notifier<bool> {
  @override
  bool build() => ref.read(sessionStoreProvider).prefs.getBool(kLocalReady) ?? false;

  Future<void> set(bool ready) async {
    final prefs = ref.read(sessionStoreProvider).prefs;
    if (ready) {
      await prefs.setBool(kLocalReady, true);
    } else {
      await prefs.remove(kLocalReady);
    }
    state = ready;
  }
}
