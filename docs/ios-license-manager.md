# App cấp phép trên iPhone/iPad: tạo App ID và TestFlight

App: `license_manager/` ("Cấp phép POS"), bundle id **com.tasotek.licenseManager**. Workflow: `.github/workflows/ios-license-manager.yml`.
Dùng **cùng 4 secret** như app POS (`APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`, `APPSTORE_API_PRIVATE_KEY`, `APPLE_TEAM_ID`), nên nếu iOS POS đã chạy được thì chỉ cần làm 2 bước dưới.

> App giữ **khóa riêng** để ký mã kích hoạt. Chỉ phân phối qua **TestFlight nội bộ** (tài khoản của bạn), không công khai, không dùng liên kết TestFlight công khai.

## Bước 1. Tạo App ID
1. https://developer.apple.com/account → **Certificates, IDs & Profiles → Identifiers → +**.
2. Chọn **App IDs → App → Continue**.
3. Description: `Cap phep POS`. Bundle ID: **Explicit** = `com.tasotek.licenseManager`.
4. Không cần bật Capability nào. **Continue → Register**.

## Bước 2. Tạo bản ghi app trên App Store Connect
1. https://appstoreconnect.apple.com → **Apps → + → New App**.
2. Platform **iOS**, Name `Cấp phép POS Tasotek` (không trùng app khác), Language Vietnamese, Bundle ID chọn `com.tasotek.licenseManager`, SKU `licensemanager`, Access **Full Access**. **Create**.

## Bước 3. Chạy workflow
1. GitHub → **Actions → iOS License Manager → Run workflow** (để ô upload bật).
2. Chờ ~10–15 phút. Build xuất hiện ở App Store Connect → app → **TestFlight** (trạng thái "Processing" vài phút).
3. Nếu Apple báo trùng số build: chạy lại với **build_number_offset** lớn hơn.

## Bước 4. Cài trên điện thoại
1. App Store Connect → app → **TestFlight → Internal Testing → +** tạo nhóm, thêm Apple ID của bạn (phải là thành viên Users and Access).
2. Trên iPhone cài app **TestFlight**, đăng nhập cùng Apple ID, bấm **Cài đặt** app "Cấp phép POS Tasotek".

## Dùng lần đầu
- Tab **Khóa**: bấm **Dán khóa riêng đã sao lưu (PEM)** sau khi sao chép nội dung file `license-private.pem` (từ máy Windows, gửi qua ghi chú mã hóa/trình quản lý mật khẩu) để dùng **cùng khóa** với máy Windows. Đừng bấm "Tạo khóa mới": khóa mới làm các bản cài của khách không nhận mã nữa.
- **Sao lưu khóa riêng** (nút chia sẻ) lưu vào nơi an toàn, không gửi qua chat công khai.
- Sổ mã đã cấp trên điện thoại là **riêng** so với máy Windows (không tự đồng bộ). Xuất CSV ở tab **Đã cấp** để gộp.
