# Hướng dẫn cấu hình ngrok cho POS Tasotek Server

ngrok tạo một **địa chỉ công khai** (ví dụ `https://ten-quan.ngrok-free.app`) trỏ về máy tính của quán, để điện thoại ngoài quán (app CoCoffee) và trang web vào được POS mà không cần mở cổng modem.

Chỉ cần làm **một lần**. Tài khoản ngrok **miễn phí** là đủ.

---

## Bước 1. Tạo tài khoản ngrok

1. Mở https://dashboard.ngrok.com/signup và đăng ký (bằng Google hoặc email).
2. Xác nhận email, đăng nhập vào https://dashboard.ngrok.com.

## Bước 2. Lấy Authtoken (bắt buộc)

1. Trong dashboard, vào menu bên trái **Getting started → Your Authtoken** (hoặc mở thẳng https://dashboard.ngrok.com/get-started/your-authtoken).
2. Bấm **Copy** để chép chuỗi token (dài, bắt đầu bằng số, ví dụ `2abc…`).
3. Giữ kín token này như mật khẩu, không gửi cho người lạ.

## Bước 3. Lấy tên miền cố định (khuyến nghị)

Tài khoản miễn phí được **1 tên miền cố định**. Nhờ đó địa chỉ không đổi mỗi lần bật máy.

1. Vào **Universal Gateway → Domains** (https://dashboard.ngrok.com/domains).
2. Bấm **Create Domain** (hoặc **+ New Domain**). ngrok cấp sẵn một tên dạng `xxxx-xxxx.ngrok-free.app` (hoặc `.ngrok-free.dev`).
3. Chép tên miền đó (không có `https://`).

> Muốn khỏi làm bước này bằng tay: nhập **API key** (Bước 4) rồi bấm **Tự lấy tên miền** trong chương trình.

## Bước 4. Tạo API key (không bắt buộc)

Chỉ cần nếu bạn muốn chương trình **tự tìm hoặc đăng ký tên miền** cho quán.

1. Vào **API** (https://dashboard.ngrok.com/api-keys) → **New API Key**.
2. Đặt tên (ví dụ `pos-quan`) → **Add API Key**.
3. Chép key ngay (chỉ hiện một lần).

## Bước 5. Nhập vào chương trình POS Tasotek Server

Mở chương trình **POS Tasotek Server** trên máy tính quán, vào tab **Cài đặt**, mục **Địa chỉ công khai (ngrok)**:

| Ô trong chương trình | Điền gì |
|---|---|
| **Bật ngrok** | Gạt sang **bật** |
| **ngrok Authtoken** | Dán token ở Bước 2 |
| **ngrok API key (tùy chọn)** | Dán key ở Bước 4, hoặc để trống |
| **Tên miền cố định** | Dán tên miền ở Bước 3 (vd `xxxx.ngrok-free.app`), hoặc bấm **Tự lấy tên miền** nếu đã nhập API key |
| **Hiện token** | Tick để kiểm tra bạn dán đúng, rồi bỏ tick |

Cuối cùng bấm **Lưu và áp dụng** (nút **Chỉ lưu** chỉ lưu, chưa chạy lại tunnel).

## Bước 6. Kiểm tra

1. Chờ vài giây, chương trình hiện trạng thái ngrok **đang chạy** và địa chỉ công khai.
2. Mở địa chỉ đó trên **điện thoại dùng 4G** (không dùng Wi‑Fi quán). Phải thấy trang đăng nhập POS.
3. Lần đầu ngrok bản miễn phí có thể hiện trang cảnh báo “You are about to visit…”: bấm **Visit Site**. Khách dùng app thì không bị.
4. Trong web quản trị: **Cài đặt → Địa chỉ công khai** cũng nên hiện đúng địa chỉ này. Nhập địa chỉ này vào app CoCoffee làm máy chủ.

---

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân và cách xử lý |
|---|---|
| `authentication failed` / `ERR_NGROK_105` | Authtoken sai hoặc thừa khoảng trắng. Chép lại ở Bước 2, tick **Hiện token** để kiểm tra. |
| `ERR_NGROK_334` (endpoint is already online) | Tên miền đang chạy ở nơi khác (máy khác, hoặc ngrok đang mở thêm một lần nữa). Tắt tiến trình ngrok cũ rồi **Lưu và áp dụng** lại. |
| `ERR_NGROK_313` / domain không hợp lệ | Tên miền không thuộc tài khoản này. Vào Domains kiểm tra, hoặc bấm **Tự lấy tên miền**. |
| Địa chỉ đổi mỗi lần bật máy | Chưa nhập **Tên miền cố định**. Làm Bước 3. |
| Điện thoại không vào được nhưng trong quán vào được | ngrok chưa chạy hoặc máy tính quán đang ngủ/tắt. Bật **Mở chương trình cùng Windows** và tắt chế độ ngủ của máy. |
| Mạng quán chặn | Một số mạng chặn ngrok. Thử đổi mạng (hotspot 4G) để xác định. |

## Lưu ý an toàn

- Authtoken và API key được lưu trong `C:\ProgramData\TasotekPOS\config.json` trên máy quán; đừng gửi file này đi.
- Địa chỉ công khai ai biết cũng mở được trang đăng nhập; hãy dùng mật khẩu mạnh (≥ 10 ký tự) và giữ **mã khôi phục** ở nơi an toàn.
- Nghi lộ token: vào dashboard ngrok → **Your Authtoken → Reset**, rồi nhập token mới vào chương trình.
