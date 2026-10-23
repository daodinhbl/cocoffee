# Đồ họa Google Play – POS Tasotek (`com.tasotek.fnb`)

Bộ ảnh cho mục *Trang thông tin chính trên cửa hàng* trong Play Console. Mọi file đều là PNG 24-bit (không kênh
alpha), đúng kích thước Play yêu cầu.

| Mục trong Play Console | File | Kích thước | Yêu cầu của Play |
|---|---|---|---|
| Biểu tượng ứng dụng | `icon/icon-512.png` | 512 × 512 | PNG 512 × 512, ≤ 1 MB. Play tự bo góc, không tự vẽ bo góc/bóng. |
| Hình ảnh nổi bật | `feature-graphic/feature-graphic-1024x500.png` | 1024 × 500 | PNG/JPG 24-bit, 1024 × 500. |
| Ảnh chụp màn hình điện thoại | `phone/01…08-*.png` | 1080 × 1920 (9:16) | 2–8 ảnh, cạnh 320–3840 px; ≥ 4 ảnh từ 1080 px để được đề xuất. |
| Ảnh máy tính bảng 7 inch | `tablet/01…05-*.png` | 1920 × 1080 (16:9) | Tối đa 8 ảnh, cạnh 320–3840 px. |
| Ảnh máy tính bảng 10 inch | `tablet/01…05-*.png` (dùng lại) | 1920 × 1080 (16:9) | Tối đa 8 ảnh, cạnh 1080–7680 px. |

Thứ tự tải lên nên giữ như số đầu tên file: ảnh đầu tiên là ảnh khách thấy trước.

## Nội dung

**Điện thoại** (khung + tiêu đề tiếng Việt):
1. `01-pos` – Bán hàng chạm là xong (POS, vẫn bán khi mất mạng)
2. `02-dashboard` – Doanh thu hôm nay, xem ngay
3. `03-orders` – Đơn Zalo về tận quầy
4. `04-tables` – Sơ đồ bàn
5. `05-inventory` – Kho tự trừ theo công thức
6. `06-reports` – Lãi gộp rõ từng món
7. `07-customers` – Sổ công nợ
8. `08-heli` – Trợ lý Heli bằng giọng nói

**Máy tính bảng**: POS, Tổng quan, Đơn hàng, Nguyên liệu, Báo cáo.

## Lưu ý trước khi tải lên

- Ảnh **máy tính bảng** dùng ảnh chụp thật của app trên tablet (`public/landing/tablet-*.jpg`).
- Màn hình trong ảnh **điện thoại** được dựng lại bằng HTML theo đúng màu, phông và bố cục của app
  (`mobile/lib/core/theme/app_theme.dart`, thanh điều hướng `core/nav.dart`), với số liệu và tên khách mẫu. Chính sách
  của Play yêu cầu ảnh thể hiện đúng trải nghiệm trong app: hãy so với app thật trên điện thoại và sửa chỗ nào lệch.
  Muốn dùng ảnh chụp thật: chụp app trên điện thoại (dữ liệu thử, không lộ số liệu thật), rồi thay phần `html:` của
  màn tương ứng trong `src/phone.html` bằng `<img src="assets/<tên>.png" style="width:100%">`.
- Số điện thoại khách trong ảnh đã che (`090•••4512`); tên khách là tên mẫu.

## Mời người thử nghiệm (`invite/`)

| File | Dùng để |
|---|---|
| `thiep-moi-thu-nghiem.png` | Thiệp 1080 × 1350 gửi qua Zalo/Facebook: 2 mã QR theo thứ tự tham gia → cài đặt. |
| `qr-tham-gia-thu-nghiem.png` / `.svg` | QR link mời: `https://play.google.com/apps/testing/com.tasotek.fnb` |
| `qr-google-play.png` / `.svg` | QR trang ứng dụng: `https://play.google.com/store/apps/details?id=com.tasotek.fnb` |
| `loi-moi.txt` | Lời mời kèm 2 link, dán thẳng vào tin nhắn. |

Người nhận phải có email trong danh sách người thử nghiệm (Play Console → *Thử nghiệm khép kín* → *Người thử nghiệm*);
trang ứng dụng chỉ mở được sau khi đã tham gia thử nghiệm, hoặc khi app đã phát hành công khai.

## Tạo lại

```bash
python CHPlay/src/render.py
```

Cần Google Chrome, Pillow và mạng (phông Be Vietnam Pro, Noto Serif, Material Symbols lấy từ Google Fonts).

- `src/phone.html#<màn>` – ảnh điện thoại; tiêu đề, màn hình và số liệu nằm trong `SCREENS`.
- `src/tablet.html#<màn>` – ảnh máy tính bảng; tiêu đề trong `SHOTS`, ảnh lấy từ `src/assets/tablet-<màn>.jpg`.
- `src/feature.html` – hình ảnh nổi bật.
- `src/assets/` – ảnh món (`public/menu`), ảnh tablet (`public/landing`), logo (`mobile/assets/brand/mark.png`),
  biểu tượng (`branding/app-icon-1024.png`, tạo bởi `branding/make-app-icon.py`).
