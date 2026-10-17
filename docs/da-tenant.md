# Nhiều quán trên một hệ thống (tenant)

Mỗi quán là một tên miền phụ `<slug>.<TENANT_BASE_DOMAIN>` và có **database MySQL riêng**. Quán chính (cocoffee) giữ database trong `DB_*`.

## Cách hoạt động
- `src/middlewares/tenant.js` đọc Host của request, tìm quán trong bảng `tenants` (cache 30 giây) và chạy cả request trong ngữ cảnh quán đó (`src/config/tenantContext.js`, AsyncLocalStorage).
- `src/config/db.js`: `pool` là lớp bọc, mỗi truy vấn đi vào pool của quán hiện tại (tối đa 3 kết nối/quán, tạo khi dùng lần đầu). Không có ngữ cảnh = quán chính. Code cũ không phải sửa.
- Sổ đăng ký quán (`tenants`, `tenant_dbs`) chỉ nằm ở database chính. Mật khẩu database của quán được mã hóa AES-256-GCM (`TENANT_SECRET`, mặc định suy ra từ khóa JWT).
- Token đăng nhập (cookie web và Bearer của app) mang `tid`: token của quán này không mở được quán khác hay quán chính.
- Cache theo quán: danh mục sản phẩm, cấu hình Zalo, cấu hình PayOn, hồ sơ cửa hàng (`env.business`).

## Đăng ký
`/dang-ky` trên trang chính: tên quán, tên miền phụ (kiểm tra còn trống), chủ quán, email, tên đăng nhập, mật khẩu (≥10 ký tự, lưu dạng bcrypt). Chống spam: 10 lần/giờ/IP và ô ẩn.
Hostinger không cho app tự tạo database, nên quy trình là: **tạo sẵn database trống trong hPanel → đăng ký vào hệ thống → khi có người đăng ký, hệ thống lấy một database trống, tạo schema và tài khoản admin**. Hết database trống thì đăng ký ở trạng thái chờ và tự hoàn tất khi thêm database.

```
node scripts/tenant.js add-db <host> <db_name> <db_user> <db_password> [port]
node scripts/tenant.js list
node scripts/tenant.js provision [<slug>]
node scripts/tenant.js suspend <slug> | resume <slug>
```
Database phải **trống hoàn toàn** (schema.sql xóa bảng cũ nên hệ thống từ chối database đã có bảng).

## Bật trên Hostinger (việc của chủ hệ thống)
Trang đăng ký chạy ở **fnb.tasotek-giaiphapso.com** (website Hostinger riêng, database riêng; website cocoffee giữ nguyên, không đặt biến tenant). Quán mới là `<slug>.fnb.tasotek-giaiphapso.com`; mở `fnb.tasotek-giaiphapso.com` sẽ chuyển tới `/dang-ky`, trang quản trị đăng ký ở `/admin/tenants` (đăng nhập admin của site fnb).
1. DNS: thêm bản ghi wildcard `*.fnb.tasotek-giaiphapso.com` trỏ về hosting và thêm wildcard subdomain cho website fnb trong hPanel (nếu gói không hỗ trợ thì mỗi quán phải thêm subdomain thủ công).
2. hPanel > website fnb > biến môi trường: `TENANT_BASE_DOMAIN=fnb.tasotek-giaiphapso.com`, `TENANT_DEFAULT_SLUG=fnb`, `TENANT_SECRET=<chuỗi ngẫu nhiên dài, giữ cố định>`; xóa `DEMO_MODE` nếu còn; đặt mật khẩu admin mạnh cho DB `u464927386_fnt_tasotek` (site fnb từng có tài khoản demo admin/admin). Sau đó deploy code mới lên site fnb.
3. Tạo vài database trống trong hPanel rồi thêm ở `/admin/tenants` (hoặc `scripts/tenant.js add-db`).

## Giới hạn hiện tại
- Chỉ chạy cho quán chính: sao lưu tự động, worker xuất sổ thuế, tổng hợp doanh thu đêm, webhook Zalo/Facebook, nhắc nợ. Quán mới dùng POS, kho, đơn, báo cáo, chi phí, thuế (xuất sổ .xlsx chưa chạy cho quán mới).
- Quán mới bắt đầu với thực đơn trống (không nạp thực đơn mẫu của cocoffee).
- Chưa có gói cước, thanh toán, xác minh email, quản trị tổng (dùng `scripts/tenant.js`).
- Tên miền phụ của quán mới đăng ký xong dùng được ngay nếu DNS wildcard đã có.
- Chưa chạy thử trên MySQL thật (máy này không có MySQL cục bộ); phần tạo schema/tài khoản được kiểm tra qua test giả lập, cần chạy thử bằng một database trống thật trước khi mở đăng ký.
