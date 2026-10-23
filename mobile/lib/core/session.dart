import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';

import 'api/api_client.dart';
import 'app_mode.dart';
import 'local/local_api_client.dart';
import 'local/local_backend.dart';
import 'local/local_db.dart';
import 'offline/connectivity.dart';
import 'offline/local_store.dart';
import 'offline/offline_db.dart';
import 'offline/offline_resolver.dart';
import 'offline/outbox.dart';
import 'offline/response_cache.dart';

/// Production server; the login screen lets staff point the app at another one (e.g. http://10.0.2.2:3000
/// for the Android emulator talking to `npm run dev` on the same PC).
const kDefaultServer = 'https://cocoffee.tasotek-giaiphapso.com';

/// HTTPS only in release builds (the OS refuses cleartext too: network_security_config.xml). Debug builds may also use
/// http:// so the emulator can reach `npm run dev` on the PC.
bool isServerUrlAllowed(String url) {
  final u = url.trim().toLowerCase();
  return u.startsWith('https://') || (!kReleaseMode && u.startsWith('http://'));
}

class AppUser {
  const AppUser({required this.id, required this.username, required this.fullName, required this.role, this.mustChangePassword = false});

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: (j['id'] as num).toInt(),
        username: '${j['username'] ?? ''}',
        fullName: '${j['full_name'] ?? j['username'] ?? ''}',
        role: '${j['role'] ?? 'cashier'}',
        mustChangePassword: _truthy(j['must_change_password']),
      );

  final int id;
  final String username;
  final String fullName;
  final String role;

  /// The token is limited to /auth/me and /auth/change-password until the password is replaced (an admin who
  /// signed in with a factory / short password, like the web's /admin/settings/password gate).
  final bool mustChangePassword;

  bool get isAdmin => role == 'admin';
  String get roleLabel => isAdmin ? 'Quản trị' : 'Thu ngân';

  /// Where the account starts: the web gives a cashier only the POS screen.
  String get home => isAdmin ? '/dashboard' : '/pos';

  AppUser copyWith({bool? mustChangePassword}) => AppUser(
        id: id, username: username, fullName: fullName, role: role, mustChangePassword: mustChangePassword ?? this.mustChangePassword);

  Map<String, dynamic> toJson() =>
      {'id': id, 'username': username, 'full_name': fullName, 'role': role, 'must_change_password': mustChangePassword};
}

bool _truthy(Object? v) => v == true || v == 1 || v == '1' || v == 'true';

/// Token in the Android keystore (flutter_secure_storage); server URL and cached user in shared preferences.
class SessionStore {
  SessionStore(this._prefs, [FlutterSecureStorage? secure]) : _secure = secure ?? const FlutterSecureStorage();

  final SharedPreferences _prefs;

  /// Local settings of this phone (the chosen Bluetooth printer...).
  SharedPreferences get prefs => _prefs;
  final FlutterSecureStorage _secure;
  String? _token;

  static const _kToken = 'auth_token';
  static const _kServer = 'server_url';
  static const _kUser = 'auth_user';

  String get serverUrl {
    final saved = _prefs.getString(_kServer);
    return saved != null && isServerUrlAllowed(saved) ? saved : kDefaultServer;
  }
  Future<void> setServerUrl(String url) => !isServerUrlAllowed(url) ? Future<void>.value() : _prefs.setString(_kServer, url.trim().replaceAll(RegExp(r'/+$'), ''));

  String? get token => _token;

  AppUser? get cachedUser {
    final raw = _prefs.getString(_kUser);
    if (raw == null) return null;
    try {
      return AppUser.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> load() async {
    try {
      _token = await _secure.read(key: _kToken);
    } catch (_) {
      _token = null; // keystore unavailable or reset: behave as signed out
    }
  }

  Future<void> save(String token, AppUser user) async {
    _token = token;
    await _secure.write(key: _kToken, value: token);
    await _prefs.setString(_kUser, jsonEncode(user.toJson()));
  }

  Future<void> clear() async {
    _token = null;
    await _secure.delete(key: _kToken);
    await _prefs.remove(_kUser);
  }
}

/// Overridden in main() once SharedPreferences and the stored token are loaded.
final sessionStoreProvider = Provider<SessionStore>((ref) => throw UnimplementedError('sessionStoreProvider'));

/// Bumped when the server URL changes so the client is rebuilt.
final serverUrlProvider = NotifierProvider<ServerUrlNotifier, String>(ServerUrlNotifier.new);

class ServerUrlNotifier extends Notifier<String> {
  /// In local mode the app's "server" is the phone ([kLocalServer]): carts, caches and links stay apart from any
  /// server account. The saved server address is kept for when the user goes back to a server.
  @override
  String build() => ref.watch(appModeProvider) == AppMode.local ? kLocalServer : ref.read(sessionStoreProvider).serverUrl;

  Future<void> set(String url) async {
    await ref.read(sessionStoreProvider).setServerUrl(url);
    state = ref.read(sessionStoreProvider).serverUrl;
  }
}

/// Where offline data lives (path_provider's application support directory, set in main()); null = memory only.
final appDirProvider = Provider<Directory?>((_) => null);

/// Durable storage for the response cache, the outbox and the saved cart (core/offline/).
final localStoreProvider = Provider<LocalStore>((ref) {
  final dir = ref.watch(appDirProvider);
  return dir == null ? MemoryStore() : FileStore(Directory('${dir.path}${Platform.pathSeparator}offline'));
});

/// The offline database of the signed-in account on this server (SQLite file in the app directory). No storage
/// (tests, memory-only runs) or nobody signed in: a disabled database that answers nothing.
final offlineDbProvider = Provider<OfflineDb>((ref) {
  final dir = ref.watch(appDirProvider);
  final user = ref.watch(accountIdProvider);
  if (dir == null || user == null || ref.watch(appModeProvider) == AppMode.local) return OfflineDb.disabled();
  final server = ref.watch(serverUrlProvider);
  final tag = server.codeUnits.fold<int>(7, (h, c) => (h * 31 + c) & 0x7fffffff).toRadixString(36);
  final db = OfflineDb(() => OfflineDb.openAt(databaseFactory, '${dir.path}${Platform.pathSeparator}offline_${tag}_u$user.db'));
  return db;
});

/// The shop of "Dùng trên máy này" (SQLite file in the app directory; tests override it with an in-memory one).
final localDbProvider = Provider<LocalDb>((ref) {
  final dir = ref.watch(appDirProvider);
  final path = dir == null ? inMemoryDatabasePath : '${dir.path}${Platform.pathSeparator}${LocalDb.fileName}';
  final db = LocalDb(databaseFactory, path);
  ref.onDispose(db.close);
  return db;
});

/// The data source of the screens: the server ([ApiClient]) or, in local mode, the phone ([LocalApiClient] over
/// [LocalBackend]). Both speak the same paths and JSON, so no screen needs to know which one it talks to.
final apiProvider = Provider<ApiClient>((ref) {
  if (ref.watch(appModeProvider) == AppMode.local) return LocalApiClient(LocalBackend(ref.watch(localDbProvider)));
  final store = ref.watch(sessionStoreProvider);
  final server = ref.watch(serverUrlProvider);
  // Cached answers are per account (a cashier and an admin do not see the same screens); rebuilt on sign-in/out.
  final userId = ref.watch(accountIdProvider);
  return ApiClient(
    serverUrl: server,
    token: () => store.token,
    onUnauthorized: () => ref.read(authProvider.notifier).expired(),
    onMustChangePassword: () => ref.read(authProvider.notifier).requirePasswordChange(),
    cache: ResponseCache(ref.watch(localStoreProvider), scope: '$server|${userId ?? 'anon'}'),
    offline: OfflineResolver(ref.watch(offlineDbProvider)),
    hasLocalEdits: () => ref.read(outboxProvider).pending.isNotEmpty,
    net: NetHooks(
      isOffline: () => !ref.read(netProvider).online,
      onOffline: () => ref.read(netProvider.notifier).markOffline(),
      onOnline: () => ref.read(netProvider.notifier).markOnline(),
    ),
  );
});

/// Id of the signed-in account (null = nobody), mirrored from [authProvider] by the notifier. The API client and
/// the offline database are scoped per account but must not watch [authProvider]: AuthNotifier itself reads them
/// (login, logout), and a provider that depends on its own reader is a cycle Riverpod rejects in debug builds.
final accountIdProvider = NotifierProvider<AccountIdNotifier, int?>(AccountIdNotifier.new);

class AccountIdNotifier extends Notifier<int?> {
  @override
  int? build() {
    final store = ref.read(sessionStoreProvider);
    final user = store.cachedUser;
    return store.token != null && user != null ? user.id : null;
  }

  void set(int? id) => state = id;
}

sealed class AuthState {
  const AuthState();
}

class SignedOut extends AuthState {
  const SignedOut([this.message]);
  final String? message;
}

class SignedIn extends AuthState {
  const SignedIn(this.user);
  final AppUser user;
}

final authProvider = NotifierProvider<AuthNotifier, AuthState>(AuthNotifier.new);

class AuthNotifier extends Notifier<AuthState> {
  @override
  AuthState build() {
    final store = ref.read(sessionStoreProvider);
    final user = store.cachedUser;
    return store.token != null && user != null ? SignedIn(user) : const SignedOut();
  }

  void _emit(AuthState next) {
    ref.read(accountIdProvider.notifier).set(next is SignedIn ? next.user.id : null);
    state = next;
  }

  /// POST /api/auth/login -> { token, must_change_password, user }
  Future<void> login(String username, String password) async {
    final res = await ref.read(apiProvider).post('/auth/login', {'username': username.trim(), 'password': password});
    var user = AppUser.fromJson(res['user'] as Map<String, dynamic>);
    if (_truthy(res['must_change_password'])) user = user.copyWith(mustChangePassword: true);
    await ref.read(sessionStoreProvider).save('${res['token']}', user);
    _emit(SignedIn(user));
  }

  /// After POST /api/auth/change-password -> { ok, token }: every older token is revoked, so the fresh one replaces
  /// the stored token, and the "must change password" gate is lifted.
  Future<void> passwordChanged(String? token) async {
    final store = ref.read(sessionStoreProvider);
    final current = state;
    final user = current is SignedIn ? current.user : ref.read(currentUserProvider);
    if (user == null) return;
    final updated = user.copyWith(mustChangePassword: false);
    final next = token != null && token.isNotEmpty ? token : store.token;
    if (next != null) await store.save(next, updated);
    if (current is SignedIn) state = SignedIn(updated);
  }

  /// Called by the API client on 403 MUST_CHANGE_PASSWORD: the router then shows the change-password screen.
  Future<void> requirePasswordChange() async {
    final current = state;
    if (current is! SignedIn || current.user.mustChangePassword) return;
    final updated = current.user.copyWith(mustChangePassword: true);
    final store = ref.read(sessionStoreProvider);
    if (store.token != null) await store.save(store.token!, updated);
    _emit(SignedIn(updated));
  }

  /// Re-reads the account (role or name may have changed in the Web Admin).
  Future<void> refreshMe() async {
    final res = await ref.read(apiProvider).get('/auth/me');
    if (state is! SignedIn) return; // signed out meanwhile
    final store = ref.read(sessionStoreProvider);
    final user = AppUser.fromJson(Map<String, dynamic>.from(res['user'] as Map));
    if (store.token != null) await store.save(store.token!, user);
    _emit(SignedIn(user));
  }

  /// Signing out on purpose also forgets the shop's data kept on the phone for this account (the SQLite copy and the
  /// cached answers); queued writes are kept and replayed at the next sign-in of the same account.
  Future<void> logout() async {
    try {
      await ref.read(offlineDbProvider).clear();
      await ref.read(apiProvider).cache?.clear();
    } catch (_) {
      // storage trouble must not keep the user signed in
    }
    await ref.read(sessionStoreProvider).clear();
    _emit(const SignedOut());
  }

  /// Called by the API client on any 401.
  Future<void> expired() async {
    if (state is SignedOut) return;
    await ref.read(sessionStoreProvider).clear();
    _emit(const SignedOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
  }
}

/// Convenience: the signed-in user (null when signed out).
final currentUserProvider = Provider<AppUser?>((ref) {
  final s = ref.watch(authProvider);
  return s is SignedIn ? s.user : null;
});
