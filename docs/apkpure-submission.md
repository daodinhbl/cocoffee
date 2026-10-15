# Hồ sơ đăng Tasotek FnB lên APKPure

Bạn tự đăng ký tài khoản nhà phát triển và tự upload. File này là nội dung để dán vào.
Số phiên bản, kích thước và SHA-256 lấy từ `releases/android/manifest.json` của bản sắp đăng
(`node -e "console.log(require('./releases/android/manifest.json'))"`).

## Thông tin kỹ thuật

| Mục | Giá trị |
|---|---|
| Tên ứng dụng | Tasotek FnB |
| Tên gói | `com.tasotek.cocoffee_mobile` |
| File | `releases/android/cocoffee-<phiên bản>.apk` (ký bằng `cocoffee-release.jks`) |
| Android tối thiểu | 7.0 (API 24) |
| Quyền sử dụng | Internet; thông báo (Android 13+); cài gói cập nhật (cập nhật trong app) |
| Danh mục gợi ý | Business / Productivity |
| Ngôn ngữ | Tiếng Việt (chính), English |

## Mô tả ngắn (≤ 80 ký tự)

- VI: Bán hàng, kho và công nợ cho quán cà phê, kết nối Zalo.
- EN: POS, stock and debt tracking for cafés, with Zalo ordering.

## Mô tả đầy đủ — Tiếng Việt

Tasotek FnB là ứng dụng quản lý quán cà phê / F&B dành cho nhân viên và chủ quán của cửa hàng dùng hệ thống Tasotek FnB. Ứng dụng cần tài khoản do cửa hàng cấp; không có đăng ký công khai.

Tính năng chính
- Bán hàng (POS): chọn bàn, thêm món, ghi chú, giảm giá, thu tiền mặt / chuyển khoản, in hóa đơn.
- Đơn từ Zalo: khách đặt món qua Zalo, chủ quán nhận thông báo đơn mới ngay trên Zalo và trên ứng dụng.
- Công nợ khách hàng: ghi nợ, thu nợ, bảng đối chiếu công nợ, gửi sao kê qua Zalo.
- Kho và định mức (BOM): nguyên liệu, nhập kho, cảnh báo sắp hết, giá vốn theo công thức.
- Báo cáo doanh thu, lợi nhuận gộp, món bán chạy.
- Hoạt động khi mất mạng: dữ liệu được lưu trên máy, thao tác bán hàng và ghi sổ được xếp hàng và tự đồng bộ khi có mạng trở lại.
- Tự kiểm tra và cập nhật phiên bản mới ngay trong ứng dụng.
- Phân quyền: quản trị viên dùng đầy đủ; thu ngân chỉ dùng chế độ POS.

## Mô tả đầy đủ — English

Tasotek FnB is a café / F&B management app for the staff and owners of shops that run the Tasotek FnB system. An account issued by the shop is required; there is no public sign-up.

Features
- Point of sale: tables, items, notes, discounts, cash / bank-transfer payments, receipts.
- Zalo orders: customers order on Zalo; the owner is notified of each new order on Zalo and in the app.
- Customer debt ledger: record debts and payments, reconciliation tables, statements sent over Zalo.
- Inventory and recipes (BOM): ingredients, stock receiving, low-stock alerts, recipe costing.
- Reports: revenue, gross profit, best sellers.
- Works offline: data is kept on the device, sales and ledger entries are queued and synced when the connection returns.
- In-app update check and installer.
- Roles: admins get everything, cashiers get the POS screen only.

## Ghi chú phiên bản (mẫu)

- VI: Thông báo đơn mới; cập nhật ngay trong ứng dụng; cơ sở dữ liệu ngoại tuyến (SQLite) để xem danh sách, tìm kiếm khi mất mạng; thu ngân chỉ dùng POS.
- EN: New-order notifications; in-app updates; offline SQLite database for browsing and searching without a connection; cashiers limited to POS.

## Cần chuẩn bị thêm (bạn làm)

1. **Ảnh chụp màn hình** (tối thiểu 4, điện thoại dọc): POS, danh sách đơn, công nợ, kho / báo cáo. Chụp trên tài khoản thử, không lộ số liệu thật.
2. **Biểu tượng** 512×512: `public/brand/icon-192.png` là bản nhỏ; cần xuất bản lớn hơn từ `public/brand/logo.png`.
3. **Chính sách quyền riêng tư (URL):** `https://cocoffee.tasotek-giaiphapso.com/privacy` (hoặc cùng đường dẫn trên tên miền fnb). Trang có sau lần deploy tiếp theo; chủ quán nên đọc lại nội dung và điền địa chỉ / số điện thoại cửa hàng (biến `SHOP_ADDRESS`, `SHOP_PHONE`) trước khi nộp.
4. **Tài khoản demo cho người duyệt:** tạo một tài khoản thu ngân thử nghiệm (không dùng tài khoản thật) và ghi vào mục "ghi chú cho người duyệt", kèm địa chỉ máy chủ để họ đăng nhập.
5. **Khóa ký:** sao lưu `mobile/android/app/cocoffee-release.jks` và `key.properties` ra ngoài máy này. Mọi bản cập nhật sau phải ký bằng đúng khóa; mất khóa là không cập nhật đè được.
