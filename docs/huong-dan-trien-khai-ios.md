# Hướng dẫn triển khai ứng dụng iOS POS Tasotek

Mục tiêu: nhân viên quét mã QR trên trang đăng nhập bằng iPhone/iPad và cài được ứng dụng, giống bản Android.
Phần máy chủ và quy trình build đã sẵn sàng (trang `/download/ios`, workflow GitHub "iOS TestFlight", script phát hành).
Việc còn lại chia làm 3 giai đoạn:

| Giai đoạn | Ai làm | Mất bao lâu | Làm mấy lần |
|---|---|---|---|
| A. Thiết lập phía Apple | Chủ app | 30 phút thao tác + 1–2 ngày Apple duyệt tài khoản | Một lần |
| B. Nạp 4 secret vào GitHub | Chủ app hoặc nhờ Claude | 10 phút | Một lần |
| C. Phát hành một bản cài | Claude (chủ app chỉ cần ra lệnh) | 15–20 phút | Mỗi lần có bản mới |

Hai cách cài trên iPhone/iPad, có thể dùng song song:

| | **Cài nội bộ (ad-hoc)** — nút "Cài đặt trực tiếp" | **TestFlight** — nút "Mở trong TestFlight" |
|---|---|---|
| Ai cài được | Chỉ máy đã đăng ký UDID (tối đa 100 iPhone + 100 iPad mỗi năm) | Bất kỳ ai có liên kết (tối đa 10 000 người) |
| Apple duyệt | Không | Có, lần đầu mỗi phiên bản (1–2 ngày) với nhóm ngoài |
| Cần cài thêm gì | Không, mở bằng Safari | Ứng dụng TestFlight |
| Hạn dùng | 1 năm | 90 ngày mỗi bản |
| Hợp với | Máy của quán, thử nghiệm nội bộ | Khách hàng, nhiều quán, trước khi lên App Store |

Tài liệu kỹ thuật (secrets, workflow, route máy chủ): `docs/ios-testflight.md`.

---

## Giai đoạn A — Thiết lập phía Apple (một lần)

### A1. Đăng ký Apple Developer Program (99 USD/năm)

1. Trên iPhone, cài ứng dụng **Apple Developer** từ App Store, đăng nhập bằng Apple ID của chủ quán (phải bật xác thực hai lớp).
2. Trong ứng dụng, chọn **Enroll Now** → cá nhân (Individual) → xác minh danh tính bằng CCCD và ảnh khuôn mặt → thanh toán bằng thẻ quốc tế.
   Đăng ký dạng tổ chức (Organization) cần thêm mã D-U-N-S của công ty, lâu hơn 1–2 tuần; với một quán thì dạng cá nhân là đủ.
3. Chờ email "Welcome to the Apple Developer Program" (thường 24–48 giờ). Chưa có email này thì các bước sau chưa làm được.

### A2. Ghi lại Team ID

developer.apple.com/account → đăng nhập → mục **Membership details** → sao chép **Team ID** (10 ký tự, ví dụ `AB12CD34EF`).

### A3. Tạo App ID `com.tasotek.fnb`

developer.apple.com/account/resources/identifiers/list → nút **+** → **App IDs** → **App** → Continue:
- Description: `POS Tasotek`
- Bundle ID: chọn **Explicit**, nhập đúng `com.tasotek.fnb`
- Capabilities: không cần tích gì → Continue → **Register**.

### A4. Tạo hồ sơ ứng dụng trên App Store Connect

appstoreconnect.apple.com → **My Apps** → **+** → **New App**:
- Platforms: iOS · Name: `POS Tasotek` · Primary Language: Vietnamese
- Bundle ID: chọn `com.tasotek.fnb` (vừa tạo ở A3) · SKU: `pos-tasotek` · User Access: Full Access → **Create**.

(Bước này cần cho TestFlight; cài nội bộ ad-hoc không bắt buộc nhưng nên làm luôn.)

### A5. Tạo API key quyền Admin

appstoreconnect.apple.com → **Users and Access** → thẻ **Integrations** → **App Store Connect API** → mục **Team Keys** → **Generate API Key** (hoặc dấu **+**):
- Name: `GitHub CI` · Access: **Admin** (bắt buộc: Apple chỉ cho tự tạo chứng chỉ ký khi key có quyền Admin).
- Bấm **Download API Key**: được file `AuthKey_XXXXXXXXXX.p8`. **Chỉ tải được một lần**; mất thì phải tạo key mới.
- Cất file vào thư mục ngoài repo, ví dụ `D:\FNB-keystore-backup\AuthKey_XXXXXXXXXX.p8` (cùng chỗ với keystore Android). Không bao giờ copy vào `D:\FNB` vì repo là công khai.
- Ghi lại **Key ID** (10 ký tự, ở cột Key ID) và **Issuer ID** (dòng chữ dài phía trên bảng).

### A6. Đăng ký máy thử (chỉ cần cho cài nội bộ)

Mỗi iPhone/iPad muốn cài trực tiếp phải được đăng ký UDID trước khi build.

Lấy UDID:
- **Windows**: cài ứng dụng **Apple Devices** từ Microsoft Store (máy cũ dùng iTunes). Cắm máy bằng cáp có truyền dữ liệu, mở khóa máy, bấm **Tin cậy** (Trust) trên iPhone. Chọn thiết bị, bấm vào dòng **Serial Number** đến khi hiện **UDID**, chuột phải → Copy.
- **Mac**: mở **Finder**, chọn iPhone ở cột trái, bấm vào dòng chữ dưới tên máy đến khi hiện **UDID**, chuột phải → Copy UDID.
- Không dùng các trang web "xem UDID" bắt cài profile: chúng có thể đọc dữ liệu khác của máy.

Đăng ký: developer.apple.com/account/resources/devices/list → **+** → Platform iOS, tích iPhone/iPad → Device Name (ví dụ `iPad quầy 1`) → Device ID (UDID) → Continue → Register. Có nhiều máy thì chọn **Register Multiple Devices** và tải lên file danh sách.

Giới hạn: 100 máy mỗi loại mỗi năm thành viên; máy xóa đi vẫn tính cho đến kỳ gia hạn.

---

## Giai đoạn B — Nạp 4 secret vào GitHub (một lần)

| Secret | Lấy ở đâu |
|---|---|
| `APPLE_TEAM_ID` | A2 |
| `APPSTORE_ISSUER_ID` | A5 |
| `APPSTORE_KEY_ID` | A5 |
| `APPSTORE_API_PRIVATE_KEY` | Toàn bộ nội dung file `.p8` (A5), kể cả dòng `-----BEGIN PRIVATE KEY-----` và `-----END PRIVATE KEY-----` |

**Cách 1 — tự làm trên GitHub:** github.com/daodinhbl/cocoffee → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, tạo lần lượt 4 secret với đúng tên ở bảng trên. Với `APPSTORE_API_PRIVATE_KEY`, mở file `.p8` bằng Notepad, Ctrl+A, Ctrl+C, dán nguyên vào ô Secret.

**Cách 2 — nhờ Claude:** gửi đường dẫn file `.p8` trên máy này cùng Team ID, Key ID, Issuer ID. Claude chạy `gh secret set` đọc thẳng từ file; nội dung key không được in ra hay lưu lại ở đâu.

Kiểm tra: `gh secret list --repo daodinhbl/cocoffee` phải liệt kê đủ 4 tên.

---

## Giai đoạn C — Phát hành một bản cài nội bộ (mỗi lần)

Chủ app chỉ cần nói "build iOS" (và đã đăng ký UDID các máy mới, nếu có); Claude làm các bước dưới. Ghi lại đây để tự làm được khi cần.

### C1. Chạy workflow trên GitHub

github.com/daodinhbl/cocoffee → **Actions** → **iOS TestFlight** → **Run workflow**:
- `upload`: bỏ tích nếu chỉ cần bản nội bộ (tích khi muốn đưa lên TestFlight luôn).
- `adhoc`: **tích** để xuất bản cài nội bộ.
- `build_number_offset`: để `0`.

Hoặc bằng dòng lệnh:

```bash
gh workflow run "iOS TestFlight" --repo daodinhbl/cocoffee --ref main -f upload=false -f adhoc=true
```

Theo dõi: `gh run watch --repo daodinhbl/cocoffee` (khoảng 10–15 phút). Lần chạy đầu thường vấp ở bước ký; xem mục "Lỗi thường gặp".

### C2. Tải bản build về

Khi run xanh, trong mục **Artifacts** có `pos-tasotek-ios-adhoc-<phiên bản>-<số build>`:

```bash
gh run download <run-id> --repo daodinhbl/cocoffee -n pos-tasotek-ios-adhoc-1.4.0-12 -D dist/ios-adhoc
```

(`<run-id>` là số ở cuối URL của run; `gh run list --repo daodinhbl/cocoffee --workflow "iOS TestFlight"` liệt kê.)

### C3. Đưa bản build vào thư mục phát hành

```bash
node scripts/publish-ipa.js dist/ios-adhoc
```

Script chép file `.ipa` và `manifest.json` vào `releases/ios/` (git-ignored), kiểm tra dung lượng và SHA-256 khớp với bản trên GitHub.

### C4. Deploy lên Hostinger

```bash
node scripts/package-deploy.js
```

rồi upload `dist/app.zip` và chạy build trên Hostinger như mọi lần (Claude làm qua API Hostinger; hoặc hPanel → Website → Node.js → tải archive lên và Deploy). `package-deploy.js` tự kèm cả APK Android lẫn bản iOS.

### C5. Nhân viên cài

1. Mở **Camera** trên iPhone/iPad, quét mã QR ở hàng "iPhone / iPad" trên trang đăng nhập (hoặc mở `https://cocoffee.tasotek-giaiphapso.com/download/ios`) — phải mở bằng **Safari**.
2. Bấm **Cài đặt trực tiếp** → iOS hỏi "cocoffee… muốn cài đặt POS Tasotek" → **Cài đặt**. Biểu tượng xuất hiện ở màn hình chính, tải xong sau vài phút.
3. Mở ứng dụng, kiểm tra địa chỉ máy chủ là `cocoffee.tasotek-giaiphapso.com`, đăng nhập bằng tài khoản trên trang quản trị.

Cập nhật bản mới: làm lại C1–C4, nhân viên quét QR và cài đè; dữ liệu đăng nhập giữ nguyên.

---

## Giai đoạn D — TestFlight và App Store (khi cần phát hành rộng)

1. Chạy workflow với `upload` tích (hoặc đẩy tag `ios-v1.4.0`). Sau 10–30 phút, build xuất hiện ở App Store Connect → **TestFlight**.
2. Lần đầu Apple hỏi **Export Compliance**: chọn "No" cho mã hóa đặc biệt (app chỉ dùng HTTPS chuẩn; `Info.plist` đã khai `ITSAppUsesNonExemptEncryption = false` nên thường không hỏi).
3. **Internal Testing**: tạo nhóm, thêm tối đa 100 người có tài khoản App Store Connect (Users and Access → + → vai trò Customer Support là đủ). Họ nhận email, cài TestFlight, bấm Accept là cài được ngay, không cần duyệt.
4. **External Testing** (cho khách, nhiều quán): tạo nhóm, thêm build, bật **Public Link**; build đầu tiên của mỗi phiên bản qua Beta App Review 1–2 ngày. Dán Public Link vào Web Admin → **Cài đặt → Ứng dụng iOS**: trang `/download/ios` và QR hiện thêm nút "Mở trong TestFlight" cho máy chưa đăng ký.
5. Lên App Store: điền thông tin ứng dụng, ảnh chụp màn hình, chính sách riêng tư (có sẵn ở `/privacy`), gửi duyệt; khi được duyệt, thay liên kết trong Cài đặt bằng địa chỉ `https://apps.apple.com/...`.

---

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Workflow dừng ngay bước đầu: "Secret … is not set" | Thiếu secret hoặc sai tên (giai đoạn B). |
| `xcodebuild archive` báo "No profiles for 'com.tasotek.fnb'" / "doesn't support the App Groups…" | App ID chưa tạo (A3) hoặc sai bundle ID. |
| "Cloud signing permission error" / "You are not allowed to perform this operation" | API key không có quyền **Admin** (A5): tạo key mới quyền Admin, cập nhật 3 secret của key. |
| Bước export ad-hoc báo "No devices registered" | Chưa đăng ký UDID nào (A6). |
| Trên iPhone bấm cài báo **Không thể cài đặt** | Máy chưa đăng ký UDID, hoặc đăng ký sau khi build: thêm UDID rồi chạy lại C1–C4. |
| Bấm nút không có gì xảy ra | Đang mở bằng Chrome/Zalo: mở lại bằng Safari. |
| Apple từ chối upload: "SDK version issue" | Runner phải dùng Xcode 26+ (workflow đã đặt `macos-26`, `latest-stable`). |
| Build number bị trùng khi upload | Chạy lại với `build_number_offset` lớn hơn số build đã có. |
| Hai nút trên `/download/ios` vẫn mờ sau deploy | `releases/ios/` chưa có `manifest.json` + `.ipa` khi chạy `package-deploy.js` (C3), hoặc deploy bằng `--no-ipa`. |

## Danh sách kiểm tra

- [ ] A1 Apple Developer Program đã kích hoạt (có email Welcome)
- [ ] A2 Team ID
- [ ] A3 App ID `com.tasotek.fnb`
- [ ] A4 Hồ sơ app "POS Tasotek" trên App Store Connect
- [ ] A5 API key quyền Admin, file `.p8` cất ngoài repo, Key ID + Issuer ID
- [ ] A6 UDID các máy thử đã đăng ký
- [ ] B 4 secret trên GitHub (`gh secret list` thấy đủ)
- [ ] C1 Workflow chạy xanh với `adhoc`
- [ ] C2–C4 `.ipa` đã publish và deploy
- [ ] C5 Một máy thử cài được từ QR
- [ ] (D) TestFlight public link dán vào Cài đặt → Ứng dụng iOS

Việc Claude làm được thay bạn: B (nếu có file `.p8`), toàn bộ C, bước 1 và 4 của D (qua API). Việc chỉ bạn làm được: A1–A6 (đăng nhập Apple), chấp nhận điều khoản Apple, thanh toán, thêm người thử nghiệm.
