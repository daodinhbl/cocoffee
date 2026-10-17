# Triển khai dịch vụ kỹ thuật tại quán (QR, bàn tư vấn, ảnh công trình, Google Maps, Zalo)

Đã có trong code: trang `/ky-thuat` (dịch vụ, công trình, form để lại SĐT), tự báo chủ quán qua Zalo khi có khách, mã QR theo từng vị trí, trang in bảng bàn tư vấn.

## 1. Mã QR theo vị trí

Mỗi vị trí dùng một mã nguồn `src` (chữ thường, số, gạch ngang) để biết chỗ nào hiệu quả. Tin Zalo gửi chủ quán có dòng "Nguồn QR".

| Vị trí | Đường dẫn QR | Ảnh QR |
|---|---|---|
| Bàn tư vấn | `/ky-thuat?src=ban-tu-van` | `/ky-thuat/qr.svg?src=ban-tu-van` |
| Bàn 1…N | `/ky-thuat?src=ban-1` | `/ky-thuat/qr.svg?src=ban-1` |
| Cuối menu | `/ky-thuat?src=menu` | `/ky-thuat/qr.svg?src=menu` |
| Hóa đơn / ly | `/ky-thuat?src=bill` | `/ky-thuat/qr.svg?src=bill` |

Cách dùng: mở ảnh QR trên trình duyệt, lưu SVG, đưa cho nơi in (SVG in nét ở mọi kích thước). Kích thước tối thiểu 3 x 3 cm; sau khi in, quét thử bằng điện thoại thật.

## 2. Bảng "Bàn tư vấn kỹ thuật"

- Mở `/ky-thuat/bang-ban?src=ban-tu-van`, in khổ A5 (Ctrl+P, tắt Headers and footers), ép plastic, đặt vào chân đế.
- Đặt ở một bàn cố định, gần cửa sổ hoặc nơi có ánh sáng, kèm tablet/điện thoại mở sẵn trang `/ky-thuat` để khách xem công trình.
- Nhân viên nói câu mở: "Anh/chị cần tư vấn điện nước, camera thì em mời qua bàn tư vấn, kỹ thuật bên em báo giá ngay."

## 3. Ảnh công trình

Ảnh nằm trong `public/cong-trinh/`, danh sách khai báo trong `public/cong-trinh/projects.json`. Chưa có ảnh nào thì mục "Công trình đã làm" tự ẩn.

```json
[
  { "title": "Camera 8 mắt cho tiệm tạp hóa", "place": "Bảo Lộc", "type": "camera", "photo": "camera-tap-hoa.jpg", "note": "Xem từ điện thoại" },
  { "title": "Tủ điện 3 pha xưởng trà", "place": "Lộc Tiến", "type": "dien", "photo": "tu-dien-xuong-tra.jpg" }
]
```

`type`: `camera`, `dien`, `nuoc`, `smarthome`, `solar`. Tên ảnh chỉ gồm chữ, số, `.`, `_`, `-`, đuôi jpg/png/webp. Mỗi mục tối đa 24 công trình.

Cách chụp (mỗi công trình 3 tấm):
1. Toàn cảnh sau khi xong, ánh sáng ban ngày, ngang tầm mắt.
2. Cận cảnh đi dây/ống/tủ điện gọn, có nhãn.
3. Trước và sau (nếu có), cùng góc chụp.

Lưu ý: xin phép chủ nhà trước khi đăng; không để lộ biển số, địa chỉ chi tiết, mặt người hoặc màn hình camera của khách. Nén ảnh dưới 300 KB (rộng 1200 px).

Sau khi thêm ảnh cần deploy lại thì ảnh mới lên máy chủ.

## 4. Hồ sơ Google Maps (Google Business Profile)

Việc này chủ quán phải tự làm trên tài khoản Google (cần xác minh bằng mã/điện thoại), không làm hộ bằng code được.

Quán đã có hồ sơ: vào business.google.com, chọn hồ sơ, thêm theo các mục dưới. Chưa có: tạo mới, loại hình chính "Quán cà phê", thêm loại phụ "Nhà thầu điện", "Dịch vụ sửa chữa nước", "Nhà thầu lắp camera an ninh" nếu danh mục có.

- **Tên:** đúng tên biển hiệu, không nhồi từ khóa (Google dễ khóa hồ sơ).
- **Mô tả (dưới 750 ký tự):**
  > Quán cà phê pha máy và cà phê võng tại Bảo Lộc. Đồng thời nhận sửa chữa, bảo trì điện nước dân dụng và công nghiệp, lắp camera an ninh, nhà thông minh, năng lượng mặt trời. Hệ thống điện, đèn và camera ngay tại quán do chính chúng tôi thi công: mời bạn ghé xem trực tiếp và nhờ kỹ thuật tư vấn miễn phí.
- **Giờ mở cửa:** giờ quán; ghi chú giờ nhận việc kỹ thuật ở phần mô tả.
- **Dịch vụ:** liệt kê từng dịch vụ (Sửa điện, Sửa nước, Lắp camera, Nhà thông minh, Điện mặt trời, Gói bảo trì), mỗi dịch vụ một dòng mô tả ngắn, giá "từ…" nếu muốn.
- **Liên kết:** website/đặt lịch trỏ tới `https://<tên miền>/ky-thuat?src=google-maps` để đo lượng khách từ Maps.
- **Ảnh:** tối thiểu 10 ảnh: mặt tiền, không gian, đồ uống, 3 ảnh công trình, ảnh đội kỹ thuật. Thêm ảnh mới mỗi tuần.
- **Bài đăng:** mỗi tuần 1 bài ("Công trình tuần này", "Mẹo kiểm tra điện nhà").
- **Đánh giá:** xin sau mỗi lần sửa xong và tại quầy (mẫu tin ở mục 5). Trả lời mọi đánh giá, kể cả xấu, trong 48 giờ. Không mua đánh giá.
- **Q&A:** tự đăng sẵn các câu hỏi thường gặp: "Có sửa điện nước ngoài giờ không?", "Có báo giá miễn phí không?".

## 5. Mẫu tin Zalo

Zalo Bot chỉ nhắn được cho người đã nhắn quán trước. Vì vậy trang `/ky-thuat` không tự nhắn khách mà báo chủ quán, chủ quán gọi hoặc nhắn tay bằng các mẫu dưới. Khách đã chat với bot của quán thì có thể gửi từ Admin > Zalo.

Thay phần trong ngoặc vuông.

**M1. Xác nhận ngay (trong 5 phút)**
> Chào [Tên], mình là [Người phụ trách] bên [Tên quán]. Em đã nhận yêu cầu [Nhu cầu] của anh/chị. Anh/chị tiện nghe máy lúc nào để em gọi tư vấn nhanh ạ?

**M2. Hẹn lịch kiểm tra miễn phí**
> Em xin hẹn kỹ thuật qua kiểm tra [điện nước/camera…] miễn phí cho anh/chị vào [giờ, ngày] tại [địa chỉ]. Nếu cần đổi giờ, anh/chị nhắn em nhé. Chỉ tính phí khi anh/chị đồng ý sửa chữa.

**M3. Nhắc lịch (trước 2 giờ)**
> Nhắc anh/chị: [giờ] hôm nay kỹ thuật [Tên thợ] sẽ tới [địa chỉ]. Anh/chị cần em báo trước khi thợ đến không ạ?

**M4. Gửi báo giá**
> Em gửi báo giá [hạng mục]: [tổng tiền], gồm [vật tư, công]. Bảo hành [thời gian]. Báo giá có hiệu lực [số ngày] ngày. Anh/chị đồng ý để em xếp lịch thi công nhé.

**M5. Sau khi sửa xong (hôm sau)**
> Cảm ơn anh/chị đã tin tưởng [Tên quán]. Mọi thứ đã ổn chưa ạ? Nếu hài lòng, anh/chị cho em xin đánh giá trên Google Maps tại: [link đánh giá]. Em cảm ơn nhiều!

**M6. Chào gói bảo trì (sau 30 ngày)**
> Chào anh/chị, [Tên quán] có gói bảo trì năm [giá]: 2 lần kiểm tra điện nước, ưu tiên xử lý trong 2 giờ khi có sự cố. Anh/chị muốn em gửi chi tiết không ạ?

**M7. Giới thiệu bạn bè**
> Anh/chị giới thiệu bạn bè dùng dịch vụ kỹ thuật, cả hai bên được tặng [ưu đãi, ví dụ 1 tuần cà phê] tại quán. Anh/chị chỉ cần nhắn tên người được giới thiệu cho em.

Quy tắc: chỉ nhắn người đã để lại SĐT hoặc từng nhắn quán; không gửi quá 1 tin tự động mỗi tuần; luôn có cách từ chối ("nhắn STOP nếu không muốn nhận tin").

## 6. Đo hiệu quả (làm hàng tuần)

- Số khách để lại thông tin theo từng `src` (tin Zalo gửi chủ quán, hoặc bảng `service_leads` trong database).
- Số khách hẹn kiểm tra, số báo giá, số chốt.
- Số lượt xem hồ sơ Google Maps và số cuộc gọi (trong Google Business Profile).
- Bỏ vị trí QR không ai quét sau 4 tuần, nhân rộng vị trí quét nhiều.

## 7. Triển khai lên máy chủ

Bảng `service_leads` được tạo tự động khi ứng dụng khởi động (`ensureSchemaUpgrades`), không cần chạy SQL. Quy trình deploy như các lần trước (xem memory "Hostinger deploy").

## Giai đoạn 2: thuế, tổng hợp, kỳ, xuất sổ (2026-10-17)

- Bảng mới: `tax_categories`, `tax_rates` (thuế suất theo ngày hiệu lực), `rev_daily`, `exp_daily`, `tax_periods`, `tax_exports`; cột snapshot thuế trên `order_items`.
- Tổng hợp ngày được cộng dồn khi ghi (đơn hoàn tất, chi phí); dựng lại bằng `node scripts/rollup.js [--days N | --all | --from --to]`. Cron gợi ý: `30 2 * * * cd <app> && node scripts/rollup.js`. App cũng tự chạy nền 02:30–04:00.
- Xuất sổ: hàng đợi `tax_exports`, 1 worker, file ở `TAX_EXPORT_DIR` (mặc định `exports/tax`), giữ 7 ngày.
- API (admin, Bearer): `/api/expenses`, `/api/expense-categories`, `/api/finance/dashboard`, `/api/tax/rates|periods/*|exports`. Mọi số thuế là ƯỚC TÍNH, kế toán phải xác nhận.
- Flutter: `lib/features/finance/` (Sổ chi phí `/expenses`, Thuế & chi phí `/finance`); ảnh chứng từ qua image_picker (≤580KB), xuất sổ tải rồi chia sẻ bằng share_plus. Chỉ hoạt động khi có mạng.
- Dữ liệu mẫu: `node scripts/seed-expenses.js` (gỡ bằng `--remove`).
