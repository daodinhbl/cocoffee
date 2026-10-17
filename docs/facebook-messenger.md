# Chatbot tư vấn trên Facebook Messenger

Fanpage nhận tin nhắn, bot tự tư vấn dịch vụ kỹ thuật (điện nước, camera, nhà thông minh, điện mặt trời, bảo trì), xin số điện thoại, lưu vào bảng `service_leads` (nguồn `facebook`) và báo chủ quán qua Zalo. Khách bấm "Gặp nhân viên" thì chủ quán được báo để vào Inbox Fanpage trả lời.

Bot không báo giá cụ thể: giá chỉ báo sau khi kỹ thuật khảo sát. Muốn bot nói giá, sửa câu trong `src/services/facebook/consultBot.js` (mục `price`).

Code: `src/webhooks/facebook/facebookRoutes.js` (webhook), `src/services/facebook/` (gửi tin, kiểm tra chữ ký, bộ trả lời).

## 1. Tạo Fanpage (nếu chưa có)

1. Đăng nhập Facebook bằng tài khoản cá nhân của chủ quán, vào facebook.com/pages/create.
2. Tên trang là tên quán, danh mục "Quán cà phê" (thêm "Dịch vụ sửa chữa" ở mô tả), thêm ảnh đại diện, ảnh bìa, SĐT, địa chỉ, giờ mở cửa.
3. Mở mục Cài đặt > Nhắn tin, bật "Cho phép mọi người nhắn tin cho trang".

## 2. Tạo Facebook App

1. Vào developers.facebook.com, đăng nhập cùng tài khoản, bấm "Bắt đầu" và đăng ký nhà phát triển (cần xác minh số điện thoại).
2. "Tạo ứng dụng", chọn trường hợp sử dụng "Khác" rồi loại "Doanh nghiệp" (Business). Đặt tên, ví dụ "CoCoffee Tư vấn".
3. Trong bảng điều khiển ứng dụng, thêm sản phẩm **Messenger** (Messenger API).
4. Cài đặt ứng dụng > Cơ bản:
   - Điền "URL chính sách quyền riêng tư": `https://<tên miền>/privacy`.
   - Bấm "Hiển thị" ở **Khóa bí mật của ứng dụng (App Secret)**: đây là giá trị `FB_APP_SECRET`.

## 3. Lấy mã truy cập của Fanpage

Trong Messenger > Cài đặt API Messenger, mục "Tạo mã truy cập": bấm "Thêm Trang", chọn Fanpage, rồi "Tạo mã". Đây là `FB_PAGE_ACCESS_TOKEN`. Giữ bí mật như mật khẩu; không gửi qua chat, không ghi vào code.

Mã tạo ở đây dùng được lâu dài miễn là bạn không đổi mật khẩu Facebook hoặc gỡ quyền của ứng dụng.

## 4. Khai báo biến môi trường trên máy chủ

Trên Hostinger (Node.js app > Environment variables), thêm:

| Biến | Giá trị |
|---|---|
| `FB_PAGE_ACCESS_TOKEN` | mã ở bước 3 |
| `FB_APP_SECRET` | khóa bí mật ở bước 2 |
| `FB_VERIFY_TOKEN` | một chuỗi tự đặt, ví dụ `cocoffee-fb-2026-xyz` (dài, khó đoán) |

Lưu ý: đặt biến môi trường trên Hostinger là thay toàn bộ danh sách, nên phải giữ lại các biến cũ (xem memory "Hostinger deploy"). Sau đó deploy/khởi động lại ứng dụng. Chưa đặt đủ `FB_PAGE_ACCESS_TOKEN` và `FB_APP_SECRET` thì webhook từ chối mọi yêu cầu (bot tắt).

## 5. Gắn webhook

Trong Messenger > Cài đặt API Messenger > "Cấu hình webhook":
- URL gọi lại: `https://<tên miền>/api/facebook/webhook`
- Mã xác minh: đúng `FB_VERIFY_TOKEN`
- Bấm "Xác minh và lưu". Thành công nghĩa là máy chủ đã chạy với biến ở bước 4.
- "Thêm đăng ký" cho Fanpage, tick **messages** và **messaging_postbacks**.

## 6. Thử

Ở chế độ Phát triển (Development), bot chỉ trả lời người có vai trò trong ứng dụng (quản trị viên, nhà phát triển, người thử nghiệm: thêm ở Vai trò ứng dụng > Vai trò). Dùng tài khoản đó nhắn vào Fanpage:
1. "Xin chào" nhận lời chào và các nút chọn.
2. "Lắp camera" nhận tư vấn camera kèm link xem công trình.
3. Gửi một số điện thoại thì bot xác nhận, và chủ quán nhận tin Zalo "Khách mới từ Facebook Messenger"; lead nằm trong `service_leads`.

## 7. Mở cho khách thật

Phải được Facebook duyệt. Vào Xem xét ứng dụng > Quyền và tính năng, xin quyền **pages_messaging** (quyền nâng cao), kèm:
- Quay video ngắn quy trình nhắn tin với bot.
- Chính sách quyền riêng tư (đã có `/privacy`).
- Có thể phải xác minh doanh nghiệp (Business Verification) với giấy phép kinh doanh. Chủ quán tự làm bước này, mình không làm thay được.
Duyệt xong, chuyển ứng dụng sang chế độ **Trực tiếp** (Live).

Quy định của Facebook cần giữ:
- Chỉ trả lời trong 24 giờ sau tin nhắn cuối của khách (bot đã làm như vậy).
- Luôn có đường gặp người thật (nút "Gặp nhân viên").
- Không nhắn quảng cáo hàng loạt cho người chưa nhắn trước.

## 8. Khi có sự cố

- "Không xác minh được webhook": kiểm tra `FB_VERIFY_TOKEN` giống hệt và ứng dụng đã khởi động lại.
- Bot im lặng: kiểm tra log của ứng dụng (dòng `Facebook send failed`) và xem mã có hết hạn không; tạo lại mã ở bước 3.
- Chữ ký sai (403): `FB_APP_SECRET` không đúng.
- Muốn xem lead: bảng `service_leads` trong database, hoặc tin Zalo báo chủ quán.
