import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/api_client.dart';

/// Production server; the login screen lets staff point the app at another one (e.g. http://10.0.2.2:3000
/// for the Android emulator talking to `npm run dev` on the same PC).
const kDefaultServer = 'https://cocoffee.tasotek-giaiphapso.com';

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
  final FlutterSecureStorage _secure;
  String? _token;

  static const _kToken = 'auth_token';
  static const _kServer = 'server_url';
  static const _kUser = 'auth_user';

  String get serverUrl => _prefs.getString(_kServer) ?? kDefaultServer;
  Future<void> setServerUrl(String url) => _prefs.setString(_kServer, url.trim().replaceAll(RegExp(r'/+$'), ''));

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
  @override
  String build() => ref.read(sessionStoreProvider).serverUrl;

  Future<void> set(String url) async {
    await ref.read(sessionStoreProvider).setServerUrl(url);
    state = ref.read(sessionStoreProvider).serverUrl;
  }
}

final apiProvider = Provider<ApiClient>((ref) {
  final store = ref.watch(sessionStoreProvider);
  final server = ref.watch(serverUrlProvider);
  return ApiClient(
    serverUrl: server,
    token: () => store.token,
    onUnauthorized: () => ref.read(authProvider.notifier).expired(),
    onMustChangePassword: () => ref.read(authProvider.notifier).requirePasswordChange(),
  );
});

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

  /// POST /api/auth/login -> { token, must_change_password, user }
  Future<void> login(String username, String password) async {
    final res = await ref.read(apiProvider).post('/auth/login', {'username': username.trim(), 'password': password});
    var user = AppUser.fromJson(res['user'] as Map<String, dynamic>);
    if (_truthy(res['must_change_password'])) user = user.copyWith(mustChangePassword: true);
    await ref.read(sessionStoreProvider).save('${res['token']}', user);
    state = SignedIn(user);
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
    state = SignedIn(updated);
  }

  /// Re-reads the account (role or name may have changed in the Web Admin).
  Future<void> refreshMe() async {
    final res = await ref.read(apiProvider).get('/auth/me');
    if (state is! SignedIn) return; // signed out meanwhile
    final store = ref.read(sessionStoreProvider);
    final user = AppUser.fromJson(Map<String, dynamic>.from(res['user'] as Map));
    if (store.token != null) await store.save(store.token!, user);
    state = SignedIn(user);
  }

  Future<void> logout() async {
    await ref.read(sessionStoreProvider).clear();
    state = const SignedOut();
  }

  /// Called by the API client on any 401.
  Future<void> expired() async {
    if (state is SignedOut) return;
    await ref.read(sessionStoreProvider).clear();
    state = const SignedOut('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
}

/// Convenience: the signed-in user (null when signed out).
final currentUserProvider = Provider<AppUser?>((ref) {
  final s = ref.watch(authProvider);
  return s is SignedIn ? s.user : null;
});
