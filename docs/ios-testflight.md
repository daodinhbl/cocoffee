# POS Tasotek trên iOS — build và đẩy TestFlight bằng GitHub Actions

Bản iOS dùng chung mã Flutter với bản Android (`mobile/`). Không cần máy Mac: macOS runner của GitHub build, ký và đẩy lên TestFlight.
Bản Android giữ nguyên quy trình cũ (`scripts\build-apk.ps1`, `scripts\build-aab.ps1`).

| | |
|---|---|
| Tên hiển thị | POS Tasotek |
| Bundle ID | `com.tasotek.fnb` (trùng package bản Play) |
| iOS tối thiểu | 15.0 |
| Thiết bị | iPhone và iPad |
| Workflow | `.github/workflows/ios-testflight.yml` |
| Ký | Apple tự quản lý (cloud signing) qua App Store Connect API key, không cần file `.p12` |

## Kích hoạt build

1. GitHub → tab **Actions** → **iOS TestFlight** → **Run workflow**.
   - Ô *upload*: bỏ chọn nếu chỉ muốn build thử và lấy file `.ipa` trong mục *Artifacts*.
   - Ô *build_number_offset*: cộng thêm vào số lần chạy để ra build number; tăng lên nếu Apple báo trùng.
2. Hoặc đẩy một tag: `git tag ios-v1.4.0 && git push origin ios-v1.4.0` (tag luôn upload lên TestFlight).
3. Build number = số lần chạy workflow (+ offset). Version lấy từ `mobile/pubspec.yaml` (`version: 1.4.0+5` → 1.4.0).
4. Khoảng 10–15 phút sau, build xuất hiện trong App Store Connect → TestFlight (chờ Apple xử lý thêm vài phút).

Workflow chạy `flutter analyze` và `flutter test` trước khi build. Biến `PLAY_STORE=true` được bật để tắt bộ tự cập nhật APK (Apple không cho app tự cập nhật).

## Secrets cần khai báo (GitHub → Settings → Secrets and variables → Actions)

| Secret | Giá trị |
|---|---|
| `APPSTORE_ISSUER_ID` | Issuer ID (App Store Connect → Users and Access → Integrations → App Store Connect API) |
| `APPSTORE_KEY_ID` | Key ID của API key |
| `APPSTORE_API_PRIVATE_KEY` | Toàn bộ nội dung file `AuthKey_XXXX.p8` (cả dòng BEGIN/END) |
| `APPLE_TEAM_ID` | Team ID 10 ký tự (developer.apple.com → Membership details) |

Repo này là public: không bao giờ commit các giá trị trên. `.gitignore` đã chặn `*.p8`, `*.p12`, `*.cer`, `*.mobileprovision`, `ExportOptions*.plist`.
Workflow chỉ chạy khi bấm tay hoặc đẩy tag `ios-v*`; không chạy trên pull request từ fork nên secrets không bị lộ.

## Những thay đổi so với bản Android

- Thêm `mobile/ios/` (sinh bằng `flutter create --platforms=ios`), bundle ID `com.tasotek.fnb`, tên "POS Tasotek", icon từ logo thương hiệu (xanh navy trên nền trắng sữa).
- `Info.plist`: `ITSAppUsesNonExemptEncryption=false`, `LSApplicationQueriesSchemes` (`tel`, `https`). Không cần quyền Bluetooth, camera hay mạng LAN (app không dùng). Giữ ATS mặc định: chỉ HTTPS, giống bản release Android.
- `lib/core/notify/new_order_watcher.dart`: thêm cấu hình thông báo iOS (xin quyền khi mở app lần đầu). Logic Android không đổi.
- `ios/Runner/AppDelegate.swift`: cho thông báo hiện cả khi app đang mở.

## Rà soát plugin

| Plugin | iOS |
|---|---|
| flutter_secure_storage, shared_preferences, path_provider, sqflite, connectivity_plus, url_launcher, dio, intl | Hỗ trợ |
| flutter_local_notifications | Hỗ trợ (đã bổ sung cấu hình iOS) |
| ota_update | **Chỉ Android.** Không gây lỗi build; code đã chặn bằng `Platform.isAndroid`, và iOS build dùng `PLAY_STORE=true` |

## CHECKLIST việc phải tự làm bằng tay

1. Đăng ký **Apple Developer Program** (99 USD/năm) cho tổ chức/cá nhân.
2. developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers** → tạo **App ID** `com.tasotek.fnb` (bật *Push Notifications* nếu sau này dùng đẩy thông báo từ máy chủ; bản hiện tại chỉ dùng thông báo cục bộ nên chưa bắt buộc).
3. App Store Connect → **My Apps → +** → New App: iOS, tên *POS Tasotek*, Bundle ID `com.tasotek.fnb`, SKU tùy ý, ngôn ngữ chính Vietnamese.
4. App Store Connect → Users and Access → Integrations → **App Store Connect API** → tạo key với quyền **Admin** (cần Admin để Apple tự tạo chứng chỉ Distribution). Tải file `.p8` (chỉ tải được một lần), ghi lại **Key ID** và **Issuer ID**.
5. Ghi lại **Team ID** (Membership details).
6. GitHub → khai báo 4 secrets ở bảng trên.
7. Chạy build đầu tiên (Run workflow). Nếu lỗi quyền ký, kiểm tra quyền Admin của API key và App ID ở bước 2.
8. TestFlight: thêm tester nội bộ (Internal Testing) để cài thử trên iPhone/iPad; điền thông tin *Test Information* và *Export Compliance* nếu được hỏi (app chỉ dùng mã hóa HTTPS chuẩn).
9. Chưa chạy trên máy thật: nên thử đăng nhập, bán hàng, thông báo đơn mới và mở hóa đơn trên iPhone và iPad trước khi nộp App Store.
