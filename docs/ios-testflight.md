# POS Tasotek trên iOS — build và đẩy TestFlight bằng GitHub Actions

> Hướng dẫn làm theo từng bước cho chủ app (tài khoản Apple, secret, đăng ký máy thử, phát hành): `docs/huong-dan-trien-khai-ios.md`. File này là phần kỹ thuật.

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

Workflow chạy `flutter analyze` và `flutter test` trước khi build. Bộ tự cập nhật (OTA) tự quyết định lúc chạy: bản **ad-hoc** (có `embedded.mobileprovision`) tự kiểm tra `/download/ios/manifest.json` và mở trình cài đặt của Apple khi có version mới hơn; bản TestFlight/App Store không bao giờ tự cập nhật (Apple cấm).

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
| ota_update | **Chỉ Android.** iOS không dùng plugin này: bản ad-hoc mở liên kết `itms-services://` bằng `url_launcher`; trên iOS chỉ so sánh tên phiên bản (1.6.0 so với 1.7.0), vì build number do CI đặt |

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

## Trang tải iOS và mã QR trên trang đăng nhập

- `/download/ios` là trang tải cho iPhone/iPad (tương ứng `/download` của Android); trang đăng nhập có mã QR riêng dẫn tới đó. iOS không cài được từ file như APK, nên trang này dẫn tới **liên kết công khai TestFlight** (bản thử nghiệm: tối đa 10 000 người, không cần đăng ký thiết bị, mỗi bản dùng 90 ngày) hoặc **trang App Store** khi đã phát hành.
- Khai báo liên kết trong Web Admin → **Cài đặt → Ứng dụng iOS** (lưu trong `app_settings`, đổi được ngay không cần deploy). Biến môi trường `IOS_APP_URL` là giá trị mặc định khi ô này để trống. Chỉ nhận địa chỉ https của `testflight.apple.com`, `beta.itunes.apple.com`, `apps.apple.com`. Chưa có liên kết thì trang và thẻ trên trang đăng nhập hiện "sắp có".
- Lấy liên kết TestFlight: App Store Connect → TestFlight → **External Testing** → tạo nhóm, thêm build, bật **Public Link** → sao chép. Build đầu tiên của mỗi phiên bản (số `version` trong pubspec) phải qua Beta App Review (thường 1–2 ngày); các build sau cùng phiên bản lên nhóm ngoài ngay. Nhóm **Internal Testing** (tối đa 100 người có tài khoản App Store Connect) dùng được ngay, không cần duyệt, nhưng không có public link.
- Khi app lên App Store, thay bằng `https://apps.apple.com/...`: nút trên trang tự đổi thành "Tải trên App Store".

## Cài nội bộ không qua TestFlight (bản ad-hoc, tải từ máy chủ của quán)

Giống bản Android: máy chủ chứa file cài và trang `/download/ios` có nút **Cài đặt trực tiếp** (mở bằng Safari). Chỉ cài được trên iPhone/iPad đã đăng ký UDID trong tài khoản Apple Developer (tối đa 100 máy mỗi loại mỗi năm), không cần Apple duyệt, không cần TestFlight; bản cài dùng được 1 năm.

1. Lấy UDID của từng máy thử nghiệm: cắm máy vào máy tính, mở Finder (macOS) hoặc iTunes/Apple Devices (Windows), bấm vào dòng số sê-ri đến khi hiện **UDID**, chuột phải → Copy. developer.apple.com → Certificates, Identifiers & Profiles → **Devices** → **+** → nhập tên và UDID.
2. GitHub → Actions → **iOS TestFlight** → Run workflow, tích **adhoc** (bỏ tích *upload* nếu chỉ cần bản nội bộ). Apple tự tạo/cập nhật hồ sơ ad-hoc với mọi máy đã đăng ký; thêm máy mới thì chạy lại workflow.
3. Tải artifact `pos-tasotek-ios-adhoc-<version>-<build>` về máy phát triển rồi phát hành:
   ```bash
   gh run download <run-id> --repo daodinhbl/cocoffee -n pos-tasotek-ios-adhoc-1.4.0-12 -D dist/ios-adhoc
   node scripts/publish-ipa.js dist/ios-adhoc
   ```
   Script chép `.ipa` + `manifest.json` vào `releases/ios/` (git-ignored, kiểm tra dung lượng và SHA-256).
4. Deploy như thường lệ (`node scripts/package-deploy.js` tự kèm `releases/ios/`, rồi upload và build trên Hostinger). Trang login hiện "v1.4.0 nội bộ" ở hàng iPhone/iPad; nhân viên quét QR bằng Safari và bấm cài.
5. Máy chưa đăng ký sẽ thấy "Không thể cài đặt": đăng ký UDID rồi chạy lại từ bước 2. Nếu đã có liên kết TestFlight, trang vẫn hiện nó bên dưới cho máy chưa đăng ký.

Máy chủ phục vụ `GET /download/ios/manifest.plist` (Apple đọc) và `GET /download/ios/app.ipa` (giới hạn 30 lượt/10 phút mỗi IP); cả hai cần HTTPS và `PUBLIC_BASE_URL` đúng tên miền công khai.
