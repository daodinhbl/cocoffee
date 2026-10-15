# CoCoffee mobile: conventions for feature work

Flutter 3.47 / Dart 3.13, Android only. **Run Flutter only as `D:\flutter_sdk\bin\flutter.bat`** (PowerShell); the real SDK path
has a space and breaks build hooks. Before a Gradle build set
`$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=D:\tmp\uds -Djava.io.tmpdir=D:\tmp'`.

## Layout rule
Every screen mirrors the Web Admin page with the same name (`views/pages/*.ejs` in `D:\FNB`): same sections in the same order,
same labels (Vietnamese), same numbers and badges. Phone (< 600 dp): the web's phone layout (swipe stat cards, table rows as
cards, dialogs as bottom sheets). Tablet (>= 840 dp): the shell shows the web sidebar; use wider grids/tables.

## Core you must reuse (do not edit files under `lib/core/` or `lib/app.dart`, `lib/main.dart`)
- `lib/core/session.dart`: `apiProvider` (ApiClient), `currentUserProvider` (AppUser: `isAdmin`, `fullName`, `role`),
  `authProvider`, `serverUrlProvider`.
- `lib/core/api/api_client.dart`: `ApiClient.get/post/put(path, ...)` -> `Map<String, dynamic>` (paths are relative to `/api`,
  e.g. `/orders`). Errors are `ApiException` with a Vietnamese `message`; `toApiException(e)`.
- `lib/core/format.dart`: `money()`, `vnd()`, `qty()`, `pct()`, `signed()`, `shopTime()`, `shopDay()`, `shopClock()`, `isoDay()`,
  `ago()`, `initial()`.
- `lib/core/theme/app_theme.dart`: `context.co` (status colours good/warn/bad/info/neutral + tints, zalo, muted, line, cta),
  `context.cs`, `context.tt`, `Palette.*`, `tabular` font features for numbers.
- `lib/core/widgets/common.dart`: `Tone`, `StatusBadge`, `PageHeader`, `StatCard`, `StatGrid`, `CountPill`, `SectionCard`,
  `EmptyState`, `ErrorPanel`, `AsyncBody`, `Thumb` (server photo or initial), `LevelBar`, `showToast`, `runWithToast`.
- `lib/core/router.dart`: routes already exist; keep your screen class names and constructors exactly as the placeholders
  (`OrderDetailScreen({required int id})`, `PosScreen({int? tableId, int? orderId})`, ...). Navigate with go_router:
  `context.push('/orders/12')`, `context.push('/inventory/3')`, `context.push('/receiving?item=3')`, `context.push('/customers/5')`,
  `context.push('/pos?table=2')`.

## State
Riverpod 3 (`flutter_riverpod` 3.4): `FutureProvider.autoDispose(.family)` for reads, `ref.invalidate(...)` after writes,
`Notifier`/`AsyncNotifier` for screen state (filters, cart). Legacy `StateProvider` lives in `package:flutter_riverpod/legacy.dart`;
prefer Notifier. Pull-to-refresh on lists (`RefreshIndicator` -> `ref.refresh(provider.future)`).

## Rules
- No new packages (pubspec is shared). Charts: draw with `CustomPaint`/plain widgets.
- All UI text in Vietnamese, same wording as the web. Money with `money()`, quantities with `qty()`, times with `shopTime()`.
- Writes: `runWithToast(context, () async {...}, success: 'Đã ...')`, then invalidate the affected providers.
- Role: the router (`redirectFor` in `lib/core/router.dart`) sends a cashier to `/pos` and only lets them open `/pos`,
  `/settings` and `/orders/:id` (like the web, which gives cashiers only the POS); admins land on `/dashboard`. An admin
  whose token says `must_change_password` is held on `/change-password`. Hide admin-only actions for cashiers.
- Put feature-only widgets/models/providers inside your feature folder (`lib/features/<feature>/`).
- Tests go in `test/features/<feature>/`. Use `test/helpers/test_app.dart`: `MockApi` (mocktail), `testApp(child, api: api,
  user: adminUser|cashierUser)`, `setSurface(tester, phone|tablet)`. Stub with
  `when(() => api.get('/orders', query: any(named: 'query'))).thenAnswer((_) async => {...})`. Run only your own: `flutter.bat test test/features/<feature>`
  and `flutter.bat analyze lib/features/<feature> test/features/<feature>` (zero issues).

## Build flavors (channel)

`direct` = the APK offered at `/download` (package `com.tasotek.cocoffee_mobile`, in-app OTA updater). `play` = the Google
Play bundle (package `com.tasotek.pos`, app name "POS Tasotek", `--dart-define=PLAY_STORE=true`, no installer
permission; see `android/app/src/play/AndroidManifest.xml`). Every build and run needs a flavor now:
`flutter run --flavor direct`, `scriptsuild-apk.ps1` (direct), `scriptsuild-aab.ps1` (play).
