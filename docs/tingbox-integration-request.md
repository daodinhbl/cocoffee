# Tích hợp TingBox (mPOS / NextPay) — việc cần xin và kế hoạch

Mục tiêu đã chốt: **khách chuyển khoản / quét QR vào TingBox → mPOS báo về máy chủ CoCoffee → tự khớp đơn hoặc
công nợ, đánh dấu "Đã thu", nhắn Zalo xác nhận cho khách và cho chủ quán.**

## Hiện trạng tìm hiểu (15/10/2026)

- `https://api.mpos.vn/receipt` trả **HTTP 200, thân rỗng** cho cả GET và POST `{}`; không có Swagger/OpenAPI công khai
  (`/swagger-ui`, `/v3/api-docs`, `developers.mpos.vn`, `docs.mpos.vn` đều không có). Không thể suy ra hợp đồng API từ
  đó, và không nên thử đoán payload trên hệ thống thật của nhà cung cấp.
- Trang [tingbox.vn](https://tingbox.vn/) chỉ ghi "tích hợp miễn phí API với POS, ERP, website", không nêu endpoint hay
  tài liệu; nút mua/liên hệ dẫn tới [nextpay.vn/lienhe.html](https://nextpay.vn/lienhe.html), hotline kinh doanh **1900 636488**.
- Giao dịch được ghi trên ứng dụng **mPOS 360 / Next360** ([app.next360.vn](https://app.next360.vn)); tiền về tài khoản
  chủ cửa hàng vào ngày hôm sau ([hướng dẫn TingBox](https://hotro.tingbox.vn/mpos-guide-tingbox-cau-hoi-thuong-gap/)).
- Tài liệu webhook của [Tingee](https://developers.tingee.vn/docs/webhook-ipn) (chữ ký `x-signature` HMAC-SHA512, trả 200,
  nhà cung cấp thử lại khi không nhận 200) là **một hãng khác**; chỉ tham khảo cách làm, không áp dụng cho mPOS.

## Gửi cho NextPay / mPOS (email hoặc Zalo của nhân viên kinh doanh)

> Kính gửi NextPay / mPOS,
>
> Cửa hàng **<tên quán>** (mã merchant/TingBox: **<mã thiết bị / serial / merchant id>**) đang dùng loa TingBox và có phần
> mềm bán hàng riêng (máy chủ Node.js, HTTPS: `https://cocoffee.tasotek-giaiphapso.com`). Chúng tôi muốn tích hợp API
> miễn phí như quảng cáo để **phần mềm tự nhận biết khách đã chuyển khoản** và chốt đơn. Xin gửi giúp:
>
> 1. **Tài liệu API** (PDF / Swagger / Postman) cho việc nhận thông báo giao dịch và (nếu có) tạo QR động theo đơn,
>    kể cả endpoint `https://api.mpos.vn/receipt`.
> 2. **Thông báo giao dịch (webhook / callback)**: cách đăng ký URL nhận thông báo; phương thức và định dạng
>    (JSON/form); **toàn bộ trường** (mã giao dịch, số tiền, nội dung chuyển khoản, thời gian, tài khoản nhận, trạng thái);
>    cách **xác thực/ký** (header, thuật toán, thứ tự ghép chuỗi ký); địa chỉ IP nguồn để mở tường lửa (nếu có); chính sách
>    **thử lại** (số lần, khoảng cách, mã phản hồi mong đợi); có gửi trùng không và cách nhận biết trùng.
> 3. **QR**: QR tĩnh của TingBox có cho gắn **nội dung/mã đơn** không; có API tạo **QR động theo số tiền + mã đơn** và
>    đẩy lên loa không; hạn dùng của QR.
> 4. **Truy vấn lại giao dịch** (để đối soát khi mất thông báo): endpoint, tham số, giới hạn tần suất.
> 5. **Môi trường thử (sandbox)** và cách **cấp / đổi khóa** (client id, secret, token); khóa có hết hạn không.
> 6. Số tiền thông báo có **sau khi trừ phí** không; thông báo gửi lúc nào (ngay khi ngân hàng báo có hay khi đối soát).
> 7. Người đầu mối kỹ thuật để hỗ trợ khi tích hợp.
>
> Xin cảm ơn.

## Khi có tài liệu, tôi sẽ làm (đã thiết kế sẵn)

1. **Tách phần độc lập nhà cung cấp** (làm được ngay, không đợi tài liệu): bảng `payment_transactions` (mã giao dịch
   duy nhất → chống xử lý hai lần), bộ khớp **số tiền + nội dung → đơn chờ thu hoặc công nợ khách**, hành động thu tiền dùng
   lại `orderService.payOrder` / `customerService.collect`, nhắn Zalo xác nhận (có sẵn `paymentNotificationService`),
   màn hình đối soát trong Admin cho giao dịch **không khớp** để chủ quán gán tay.
2. **Bộ chuyển đổi mPOS** (đợi tài liệu): `POST /api/payments/mpos/webhook` — kiểm chữ ký bằng so sánh thời gian hằng
   (`crypto.timingSafeEqual`), giới hạn kích thước, trả mã phản hồi đúng yêu cầu của mPOS, ghi log mọi yêu cầu bị từ chối.
3. **Cấu hình**: khóa/secret nhập ở Admin > Cài đặt hoặc biến môi trường trên hPanel — **không** ghi vào mã nguồn,
   không dán vào chat.
4. **Kiểm thử**: test giả lập payload mẫu từ tài liệu (khớp đúng, thiếu tiền, dư tiền, trùng giao dịch, sai chữ ký,
   nhiều đơn cùng số tiền), thử trên sandbox trước khi bật ở site thật.

## Quyết định cần Sếp khi có tài liệu

- **Khớp thế nào khi thiếu/dư tiền** (đề xuất: thu một phần vào công nợ khách nếu nhận ra khách, còn lại để "chờ gán").
- **Nhận ra khách bằng gì** (mã đơn trong nội dung chuyển khoản, số tiền trùng đơn đang chờ thu, hay số điện thoại).
- Có muốn **QR động theo đơn** trên màn hình POS (hướng "đẩy đơn lên loa") ở giai đoạn sau không.
