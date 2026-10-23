import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/app_mode.dart';
import '../../core/router.dart';
import '../../core/session.dart';

/// Where new shops are created: the main site (POST /api/signup, src/routes/signupApiRoutes.js). A build may point
/// elsewhere with `--dart-define=SIGNUP_SERVER=https://...`.
const kSignupServer = String.fromEnvironment('SIGNUP_SERVER', defaultValue: kDefaultServer);

/// Client for the sign-up endpoints (no token, no cache); tests override it.
final signupApiProvider = Provider<ApiClient>((ref) => ApiClient(serverUrl: kSignupServer, token: () => null, onUnauthorized: () {}));

/// GET /api/signup -> { open, base_domain }: is sign-up open, and under which domain the shops live.
final signupInfoProvider = FutureProvider.autoDispose<({bool open, String baseDomain})>((ref) async {
  final res = await ref.watch(signupApiProvider).get('/signup', useCache: false);
  return (open: res['open'] != false, baseDomain: '${res['base_domain'] ?? ''}');
});

/// What the "Tạo quán mới" form sends (the same fields as /dang-ky).
class SignupForm {
  const SignupForm({
    required this.name,
    required this.slug,
    required this.ownerName,
    required this.email,
    this.phone = '',
    required this.username,
    required this.password,
    required this.password2,
  });

  final String name, slug, ownerName, email, phone, username, password, password2;

  Map<String, dynamic> toJson() => {
        'name': name.trim(),
        'slug': slug.trim().toLowerCase(),
        'ownerName': ownerName.trim(),
        'email': email.trim(),
        if (phone.trim().isNotEmpty) 'phone': phone.trim(),
        'username': username.trim().toLowerCase(),
        'password': password,
        'password2': password2,
      };
}

/// A shop registered on the server. [pending]: no spare database yet, it opens when the operator adds one.
class PendingShop {
  const PendingShop({required this.slug, required this.url, required this.username, required this.name});

  factory PendingShop.fromJson(Map<String, dynamic> j) =>
      PendingShop(slug: '${j['slug']}', url: '${j['url']}', username: '${j['username'] ?? ''}', name: '${j['name'] ?? ''}');

  final String slug, url, username, name;

  Map<String, dynamic> toJson() => {'slug': slug, 'url': url, 'username': username, 'name': name};
}

const _kPending = 'pending_signup';

/// A sign-up still waiting for its database, remembered so the welcome page can check it again.
final pendingShopProvider = NotifierProvider<PendingShopNotifier, PendingShop?>(PendingShopNotifier.new);

class PendingShopNotifier extends Notifier<PendingShop?> {
  @override
  PendingShop? build() {
    final raw = ref.read(sessionStoreProvider).prefs.getString(_kPending);
    if (raw == null) return null;
    try {
      return PendingShop.fromJson(Map<String, dynamic>.from(jsonDecode(raw) as Map));
    } catch (_) {
      return null;
    }
  }

  Future<void> set(PendingShop? shop) async {
    final prefs = ref.read(sessionStoreProvider).prefs;
    if (shop == null) {
      await prefs.remove(_kPending);
    } else {
      await prefs.setString(_kPending, jsonEncode(shop.toJson()));
    }
    state = shop;
  }
}

/// The field a sign-up error belongs to (`details.field` of the API error), to show it under that input.
String? errorField(Object e) {
  final d = e is ApiException ? e.details : null;
  return d is Map && d['field'] is String ? d['field'] as String : null;
}

/// GET /api/signup/check?slug= -> (free?, message).
Future<({bool ok, String message})> checkSlug(ApiClient api, String slug) async {
  final res = await api.get('/signup/check', query: {'slug': slug.trim().toLowerCase()}, useCache: false);
  return (ok: res['ok'] == true, message: '${res['message'] ?? ''}');
}

/// Creates the shop. Active: the app now talks to the shop's own address and signs in with the new account.
/// Pending: remembered for the welcome page; returns it. Errors reach the caller (field in [errorField]).
Future<PendingShop?> createServerShop(WidgetRef ref, SignupForm form) async {
  final res = await ref.read(signupApiProvider).post('/signup', form.toJson());
  final shop = PendingShop(slug: '${res['slug']}', url: '${res['url']}', username: '${res['username'] ?? form.username}', name: form.name.trim());
  if (res['status'] != 'active') {
    await ref.read(pendingShopProvider.notifier).set(shop);
    return shop;
  }
  await openServerShop(ref, shop.url, username: shop.username, password: form.password);
  return null;
}

/// GET /api/signup/status?slug= for a waiting sign-up: 'active', 'pending' or 'unknown'.
Future<String> pendingStatus(ApiClient api, String slug) async {
  final res = await api.get('/signup/status', query: {'slug': slug}, useCache: false);
  return '${res['status'] ?? 'unknown'}';
}

/// Switches the app to the shop at [url] (server mode). With a [password] it also signs in; without one the login
/// screen opens on that shop.
Future<void> openServerShop(WidgetRef ref, String url, {String? username, String? password}) async {
  await ref.read(serverUrlProvider.notifier).set(url);
  await ref.read(appModeProvider.notifier).set(AppMode.server);
  await ref.read(pendingShopProvider.notifier).set(null);
  if (username != null && password != null) await ref.read(authProvider.notifier).login(username, password);
}

/// "Dùng trên máy này", first run: a blank database on the phone with the shop's name, its admin account and,
/// when asked, a few sample dishes; then signs in with that account.
Future<void> createLocalShop(
  WidgetRef ref, {
  required String shopName,
  required String fullName,
  required String username,
  required String password,
  bool sampleMenu = false,
}) async {
  final db = ref.read(localDbProvider);
  // A shop already in the file (the app's settings were reset, the database kept): open it instead.
  if (!await db.isSetUp()) {
    await db.setUp(shopName: shopName, fullName: fullName, username: username, password: password, sampleMenu: sampleMenu);
  }
  // The setup screen stays up (local mode, not ready yet) until the sign-in lands on the home screen.
  await ref.read(appModeProvider.notifier).set(AppMode.local);
  try {
    await ref.read(authProvider.notifier).login(username, password);
  } finally {
    await ref.read(localReadyProvider.notifier).set(true); // a failed sign-in leaves the local login screen
  }
}

/// "Xóa toàn bộ dữ liệu trên máy": signs out, deletes the local shop's database and its saved cart, and goes back to
/// the welcome page.
Future<void> wipeLocalShop(WidgetRef ref) async {
  // Everything is read up front: signing out closes the settings screen, and its [ref] with it.
  final auth = ref.read(authProvider.notifier);
  final db = ref.read(localDbProvider);
  final store = ref.read(localStoreProvider);
  final ready = ref.read(localReadyProvider.notifier);
  final mode = ref.read(appModeProvider.notifier);
  final router = ref.read(routerProvider);
  await auth.logout();
  await db.wipe(); // the same instance opens a blank file on next use
  try {
    await store.clear('cart:$kLocalServer');
  } catch (_) {
    // the cart is rebuilt empty anyway
  }
  await ready.set(false);
  await mode.set(AppMode.unset);
  router.go('/welcome');
}

/// Back to the welcome page from the login screen ("Chọn cách khác"). Nothing is deleted: a local shop or the saved
/// server address are still there when the same choice is made again.
Future<void> chooseAgain(WidgetRef ref) => ref.read(appModeProvider.notifier).set(AppMode.unset);
