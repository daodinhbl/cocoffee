# Đăng POS Tasotek lên Google Play

Ứng dụng trên Google Play là **POS Tasotek**, tên gói **`com.tasotek.fnb`** — một bản riêng (flavor `play`) của app
trong `mobile/`. Bản tải trực tiếp từ `/download` của máy chủ (flavor `direct`, gói `com.tasotek.cocoffee_mobile`,
tự cập nhật OTA) vẫn giữ nguyên. Hai bản cài song song được trên cùng điện thoại và không cập nhật lẫn nhau:
Google ký lại bản Play bằng khóa riêng của Google, nên chữ ký khác bản direct.

> Tên gói bị khóa vĩnh viễn ngay lần tải gói đầu tiên lên Play Console. Muốn đổi thì phải tạo ứng dụng khác.

## 1. Build gói .aab

```bash
powershell -ExecutionPolicy Bypass -File scripts\build-aab.ps1
```

Kết quả: `dist\play\tasotek-fnb-<phiên bản>.aab` (ví dụ `tasotek-fnb-1.4.0-5.aab`).

Script chạy `flutter build appbundle --release --flavor play --dart-define=PLAY_STORE=true`:
- không có quyền cài gói, không có trình cập nhật trong app (Play tự cập nhật; Play cấm app tự cài bản mới);
- ký bằng khóa tải lên trong `mobile/android/key.properties` + `cocoffee-release.jks` (không có file này thì build
  dừng — Play từ chối gói ký bằng khóa debug);
- kèm bảng ký hiệu native (`BUNDLE-METADATA/.../*.sym`) để Play đọc được crash native.

Mỗi lần tải gói mới lên, `versionCode` phải lớn hơn lần trước: tăng `version:` trong `mobile/pubspec.yaml` (số sau
dấu `+`) và `kAppVersion` / `kAppBuild` trong `mobile/lib/features/settings/settings_models.dart`.

Nếu gặp `Release app bundle failed to strip debug symbols`: Flutter gọi `apkanalyzer.bat` từ đường dẫn SDK Android
có dấu cách và lệnh đó hỏng. Máy này đã có junction `D:\android_sdk` → `%LOCALAPPDATA%\Android\Sdk` và
`flutter config --android-sdk D:\android_sdk`; máy khác làm tương tự.

## 2. Lần đầu: tải lên bản thử nghiệm nội bộ

Play Console → ứng dụng **POS Tasotek** → *Kiểm thử và phát hành* → *Thử nghiệm nội bộ* → *Tạo bản phát hành mới*.

1. **Gói ứng dụng**: kéo file `.aab` vào ô tải lên. Lần đầu Play hỏi về *Play App Signing*: chấp nhận (Google giữ
   khóa ký phát hành, file ta tải lên được ký bằng khóa tải lên). Vẫn phải giữ `cocoffee-release.jks` + `key.properties`
   sao lưu ngoài máy: mất khóa tải lên thì phải xin Google cấp lại.
2. **Tên bản phát hành**: `1.4.0 (5)`.
3. **Ghi chú phát hành** (mục 5 bên dưới).
4. *Tiếp theo* → *Lưu và xuất bản*. Bản nội bộ không cần Google duyệt, có ngay sau vài phút.
5. Tab *Người thử nghiệm*: tạo danh sách email (tối đa 100), lưu, rồi gửi **đường liên kết tham gia** cho họ.
   Người thử nghiệm mở link, bấm tham gia, rồi cài từ Play như app bình thường.

## 3. Việc phải xong trước khi phát hành công khai

Mục *Trang tổng quan* của ứng dụng liệt kê các việc còn thiếu. Với app này:

| Mục | Điền |
|---|---|
| Quyền truy cập ứng dụng | *Toàn bộ hoặc một số chức năng bị hạn chế* → thêm hướng dẫn: địa chỉ máy chủ `https://cocoffee.tasotek-giaiphapso.com` (màn đăng nhập có nút *Đổi* địa chỉ) + **tài khoản dành cho người duyệt** (tạo riêng một tài khoản quản trị viên trên site cocoffee, ví dụ `googlereview`, mật khẩu ≥ 10 ký tự; không dùng tài khoản thật). |
| Quảng cáo | Không có quảng cáo. |
| Xếp hạng nội dung | Bảng câu hỏi: loại *Tiện ích / năng suất*; trả lời *Không* cho mọi mục nhạy cảm. |
| Đối tượng mục tiêu | 18 tuổi trở lên; không hướng tới trẻ em. |
| Ứng dụng tin tức | Không. |
| Ứng dụng truy vết COVID-19 | Không. |
| An toàn dữ liệu | Xem mục 4. |
| Ứng dụng chính phủ | Không. |
| Tính năng tài chính | Không cung cấp dịch vụ tài chính (app chỉ ghi nhận thanh toán của quán; mã VietQR là thông tin chuyển khoản của quán). |
| Ứng dụng sức khỏe | Không. |
| Chính sách quyền riêng tư | `https://cocoffee.tasotek-giaiphapso.com/privacy` (trang đã có trên site). |
| Danh mục | Ứng dụng → *Kinh doanh*. Email liên hệ: email của bạn. |
| Trang thông tin trên cửa hàng | Tên **POS Tasotek**; mô tả ở mục 5; đồ họa ở mục 6. |

**Tài khoản cá nhân** (như tài khoản này): Google yêu cầu *xác minh danh tính nhà phát triển* (mục *Xác minh nhà phát
triển Android* ở menu trái) và, với tài khoản tạo sau 13/11/2023, phải chạy **thử nghiệm khép kín với ít nhất 12
người thử nghiệm tham gia liên tục 14 ngày** rồi mới được nộp đơn xin quyền phát hành công khai. Nên tạo bản *Thử
nghiệm khép kín* sớm (cùng file `.aab`) và mời đủ 12 người (nhân viên, chủ quán, bạn bè) cài và giữ app trong 14 ngày.

## 4. Biểu mẫu An toàn dữ liệu (gợi ý, bạn rà lại)

Dữ liệu trong app là dữ liệu kinh doanh của quán, lưu trên máy chủ của quán. Tin Zalo do máy chủ gửi, không phải
app. Câu hỏi cho trợ lý Heli được máy chủ gửi sang OpenAI; OpenAI là **nhà cung cấp dịch vụ** xử lý thay quán, nên theo
định nghĩa của Play đó không tính là "chia sẻ" (vẫn phải khai là "thu thập" và ghi rõ trong chính sách quyền riêng tư,
mục 4 của `/privacy`).

- Ứng dụng có thu thập hoặc chia sẻ dữ liệu người dùng? **Có** (thu thập), **không** chia sẻ.
- Dữ liệu được mã hóa khi truyền? **Có** (HTTPS).
- Người dùng có thể yêu cầu xóa dữ liệu? **Có** — qua quản trị viên của quán (ghi trong chính sách quyền riêng tư).
- Loại dữ liệu:
  - *Thông tin cá nhân → Tên*: thu thập, bắt buộc, mục đích *Chức năng ứng dụng* (tên khách hàng ghi nợ, tên nhân viên).
  - *Thông tin cá nhân → Số điện thoại*: thu thập, không bắt buộc, *Chức năng ứng dụng* (số của khách hàng).
  - *Thông tin cá nhân → Mã nhận dạng người dùng*: thu thập, bắt buộc, *Chức năng ứng dụng, Quản lý tài khoản* (tên đăng nhập; Zalo ID của khách).
  - *Thông tin tài chính*: **không** (app không thu thẻ hay tài khoản ngân hàng của người dùng).
  - *Ảnh và video → Ảnh*: thu thập, **không bắt buộc**, mục đích *Chức năng ứng dụng* (ảnh hóa đơn/biên lai người dùng
    tự chụp hoặc chọn trong phiếu chi, gửi lên máy chủ của quán). Không chia sẻ.
  - *Tin nhắn → Tin nhắn khác trong ứng dụng* (hoặc *Hoạt động trong ứng dụng → Nội dung khác do người dùng tạo*):
    thu thập, **không bắt buộc**, mục đích *Chức năng ứng dụng* (câu hỏi gõ hoặc nói cho Heli, dạng chữ; máy chủ chuyển
    cho OpenAI với vai trò nhà cung cấp dịch vụ, chỉ giữ tạm trong bộ nhớ). Được xử lý tạm thời: **Có**.
  - *Âm thanh*: không. Giọng nói được dịch vụ nhận dạng giọng nói của Android đổi thành chữ ngay trên điện thoại; app
    và máy chủ chỉ nhận chữ, không ghi âm.
  - *Vị trí, Tệp, Danh bạ, Mã thiết bị, Thông tin về ứng dụng, Sinh trắc học*: không (Bluetooth chỉ để nối máy in đã
    ghép đôi, có cờ `neverForLocation`; vân tay/khuôn mặt do Android xử lý, app chỉ nhận đúng/sai).

## 5. Nội dung trang cửa hàng

**Tên**: POS Tasotek

**Mô tả ngắn** (≤ 80 ký tự)
- VI: Bán hàng, kho và công nợ cho quán cà phê, kết nối Zalo.
- EN: POS, stock and debt tracking for cafés, with Zalo ordering.

**Mô tả đầy đủ**: dùng phần *Mô tả đầy đủ — Tiếng Việt / English* trong `docs/apkpure-submission.md`, đổi tên
"Tasotek FnB" thành "POS Tasotek" và bỏ câu *Tự kiểm tra và cập nhật phiên bản mới ngay trong ứng dụng* (bản Play
không có chức năng đó).

**Ghi chú phát hành 1.4.0 (5)**
- VI: Thông báo đơn mới từ Zalo; cơ sở dữ liệu ngoại tuyến: xem, tìm kiếm, bán hàng, ghi sổ khi mất mạng và tự đồng bộ khi có mạng; thu ngân chỉ dùng màn POS.
- EN: New-order notifications from Zalo; offline database: browse, search, sell and keep the books without a connection, synced when it returns; cashiers limited to the POS screen.

## 6. Đồ họa

Bộ đồ họa đã dựng sẵn trong `CHPlay/` (biểu tượng, hình ảnh nổi bật, 8 ảnh điện thoại, 5 ảnh máy tính bảng); cách
tạo lại và lưu ý xem `CHPlay/README.md`.

| Mục | Yêu cầu của Play |
|---|---|
| Biểu tượng | PNG 512 × 512, không trong suốt, ≤ 1 MB. Xuất từ `public/brand/logo.png`. |
| Hình ảnh nổi bật | PNG/JPG 1024 × 500. |
| Ảnh chụp màn hình điện thoại | 2–8 ảnh, PNG/JPG, cạnh 320–3840 px, tỷ lệ 16:9 hoặc 9:16. Gợi ý: POS, đơn hàng, công nợ, kho, báo cáo — chụp trên tài khoản thử, không lộ số liệu thật. |
| Ảnh máy tính bảng 7" và 10" | Không bắt buộc, nhưng app có bố cục máy tính bảng nên nên có 2–4 ảnh mỗi loại. |

## 7. Các lần phát hành sau

1. Tăng phiên bản (mục 1), commit.
2. `scripts\build-aab.ps1` → tải `.aab` mới lên *Thử nghiệm nội bộ* (hoặc *Phát hành công khai* khi đã được phép).
3. Bản direct vẫn phát hành như cũ: `scripts\build-apk.ps1` rồi deploy máy chủ (`scripts/package-deploy.js`).
