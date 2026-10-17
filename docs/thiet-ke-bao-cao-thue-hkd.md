# Thiết kế: Báo cáo thuế cho hộ kinh doanh (phương pháp kê khai) trong CoCoffee POS

Ngày soạn: 17/10/2026. Phạm vi: Node.js (Express) + MySQL trên Hostinger + app Flutter hiện có.
**Đây là thiết kế kỹ thuật, không phải tư vấn thuế.** Mọi tỷ lệ, ngưỡng, mẫu biểu phải được kế toán/chi cục thuế xác nhận bằng văn bản gốc trước khi dùng để kê khai thật (xem mục 8).

---

## 0. Điều chỉnh tiền đề (quan trọng, đọc trước)

Đề bài dựa trên TT 40/2021/TT-BTC và TT 88/2021/TT-BTC. Theo các nguồn tôi tra được ngày 17/10/2026 (đều là trang tư vấn/kế toán, **chưa đối chiếu văn bản gốc**), khung này đã đổi từ 01/01/2026:

| Nội dung | Trước 2026 | Từ 01/01/2026 (cần xác minh) |
|---|---|---|
| Thuế khoán, lệ phí môn bài | Có | Bãi bỏ (Nghị quyết 198/2025/QH15); HKD tự kê khai, tự nộp |
| Chế độ kế toán HKD | TT 88/2021/TT-BTC | **TT 152/2025/TT-BTC** (hiệu lực 01/01/2026), số sổ linh hoạt theo nhóm hộ |
| Ngưỡng không phải nộp GTGT/TNCN | 100 triệu/năm | 500 triệu/năm; có nguồn nói đã nâng lên **1 tỷ** (NĐ 141/2026/NĐ-CP sửa NĐ 68/2026/NĐ-CP) → **mâu thuẫn, phải kiểm** |
| Kỳ kê khai | Theo từng nhóm | Doanh thu > ngưỡng đến 50 tỷ: **theo quý** (hạn: cuối tháng đầu quý sau); > 50 tỷ: theo tháng |
| Mẫu sổ | TT 88 (S1–S7) | S1a-HKD (không chịu thuế), **S2a-HKD** (nộp GTGT+TNCN theo tỷ lệ % trên doanh thu), các sổ khác theo nhóm |

**Hệ quả thiết kế:** quy định đang thay đổi nhanh. Vì vậy **không được hard-code tỷ lệ/ngưỡng/mẫu sổ trong code**; mọi thứ đi qua bảng cấu hình có hiệu lực theo ngày (mục 3). Khi luật đổi, chỉ thêm một dòng cấu hình, không sửa code, không tính lại quá khứ.

---

## 1. Nghiệp vụ & công thức cho quán cà phê

### 1.1 Phân loại doanh thu (theo mặt hàng, không theo cả đơn)

Một đơn của CoCoffee có thể trộn nhiều ngành → phải gắn nhóm thuế **ở từng dòng món**.

| Nhóm thuế (`tax_category`) | Ví dụ trong menu | GTGT (% DT) | TNCN (% DT)* |
|---|---|---|---|
| Dịch vụ ăn uống (đồ uống pha chế, đồ ăn) | 25 món đồ uống | 3% | 1,5% |
| Phân phối hàng hóa (bán nguyên trạng) | Thuốc lá, nước đóng chai bán lại | 1% | 0,5% |
| Khác / không chịu thuế | Thu hộ, tiền đặt cọc | 0 | 0 |

\* Tỷ lệ theo các nguồn đã tra; TNCN có **hai cách tính khác nhau** được các nguồn nêu cho nhóm 500 triệu – 3 tỷ (xem 1.3). Để cấu hình, đừng cố định.

### 1.2 Công thức (phương pháp trực tiếp trên doanh thu)

```
DT_nhóm(kỳ)   = Σ line_total của các dòng món thuộc nhóm, đơn hoàn tất trong kỳ, đã trừ giảm giá phân bổ
GTGT_nhóm     = DT_nhóm × tỷ_lệ_GTGT(nhóm, ngày)
GTGT_kỳ       = Σ GTGT_nhóm
```

- **Giảm giá cấp đơn** (`orders.discount`) phải **phân bổ theo tỷ lệ** về từng dòng (làm tròn dồn phần dư vào dòng lớn nhất) để DT từng nhóm đúng.
- **Tiền trả trước / hoàn tiền:** doanh thu tính theo đơn **hoàn tất**, không theo `payments` (bảng payments là sổ quỹ, không phải sổ doanh thu).
- **Đơn ghi nợ** (Zalo, chưa thu): vẫn là doanh thu khi đã giao hàng/hoàn tất; ghi cột "đã thu/chưa thu" ở sổ.
- **Đơn hủy:** loại.
- **Ngưỡng:** nếu `DT_lũy_kế_năm ≤ ngưỡng_miễn` thì GTGT = TNCN = 0 cho kỳ, nhưng **vẫn phải ghi sổ** và nộp thông báo doanh thu theo quy định.

### 1.3 TNCN: để cấu hình, không hard-code

| Cách | Công thức | Khi dùng |
|---|---|---|
| A. Theo tỷ lệ trên doanh thu | `TNCN = (DT − phần_ngưỡng_trừ) × tỷ_lệ_nhóm` | HKD không tách được chi phí |
| B. Theo lợi nhuận | `TNCN = (DT − chi_phí_hợp_lý − phần_ngưỡng_trừ) × thuế_suất` (15% với 500 tr–3 tỷ theo một số nguồn) | HKD có sổ chi phí đầy đủ, chọn B |

`tax_rates` có cột `pit_method` (`revenue_rate` / `profit_rate`) và `pit_deduction` (số trừ). Kế toán của chủ quán chọn cách, hệ thống tính theo cách đó. Đây là lý do cần **Sổ chi phí** (mục 3.4): có thể không dùng ngay, nhưng dữ liệu phải sẵn.

### 1.4 Việc phải sửa ở hóa đơn hiện tại

Hóa đơn đang in dòng **"Đã gồm VAT 8%"** (`printerSettings.showVat`). Với HKD nộp GTGT theo tỷ lệ trên doanh thu, dòng này **sai về bản chất** (hộ không khấu trừ, không tách VAT 8% vào giá). Đề xuất: mặc định tắt `showVat` khi bật chế độ thuế HKD; nếu quán dùng hóa đơn điện tử từ máy tính tiền thì theo mẫu hóa đơn do cơ quan thuế/nhà cung cấp quy định.

---

## 2. Tổng quan kiến trúc

```
POS (Flutter/Web) ──► orderService.payOrder ──┐
                                               │ (cùng transaction)
                          snapshot thuế dòng món + upsert tax_daily_summary
                                               ▼
MySQL: order_items(+tax snapshot) │ tax_daily_summary │ tax_periods │ expenses │ tax_exports
                                               ▲
Chủ quán (Flutter) ──► GET /api/tax/dashboard ─┘   (đọc rollup, < 100 dòng)
                  └─► POST /api/tax/exports ──► bảng tax_exports (queued)
                                                     ▲
                       worker 1 luồng trong process Node (poll 5 s) ── ghi file ──► tải về
```

Nguyên tắc: **tính một lần lúc bán, đọc nhiều lần lúc báo cáo.** Truy vấn tổng hợp trên `order_items` lớn không bao giờ chạy trên đường nóng.

---

## 3. Thiết kế database (MySQL)

### 3.1 Cấu hình thuế có hiệu lực theo ngày (chống đổi luật làm hỏng quá khứ)

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `tax_categories` | `id`, `code` (`fnb_service`, `goods_distribution`, `none`), `name`, `ledger_group` | Nhóm ngành thuế |
| `tax_rates` | `id`, `category_id`, `effective_from` DATE, `effective_to` DATE NULL, `vat_rate` DECIMAL(5,4), `pit_rate` DECIMAL(5,4), `pit_method`, `pit_deduction` DECIMAL(14,2), `exempt_threshold` DECIMAL(14,2), `legal_basis` VARCHAR(200) | **Không UPDATE dòng cũ**: đổi luật = đóng `effective_to` và thêm dòng mới. UNIQUE (`category_id`, `effective_from`) |
| `tax_profile` (1 dòng) | `owner_name`, `tax_code`, `business_address`, `declaration_period` (`quarter`/`month`), `accounting_form` (mã nhóm sổ theo TT 152), `pit_method` | Thông tin in lên sổ/tờ khai |

### 3.2 Gắn thuế vào dữ liệu hiện có

| Bảng | Thêm cột | Mục đích |
|---|---|---|
| `products` | `tax_category_id` (FK, mặc định `fnb_service`; sản phẩm thuộc danh mục "Thuốc lá" → `goods_distribution`) | Phân loại một lần ở menu |
| `order_items` | `tax_category_id`, `vat_rate`, `pit_rate`, `net_revenue` DECIMAL(14,2) (đã trừ phần giảm giá phân bổ) | **Snapshot lúc hoàn tất đơn**: sau này đổi tỷ lệ, đơn cũ không đổi. Cùng ý tưởng với `unit_cogs` đang có |
| `orders` | `tax_locked_period_id` NULL | Đơn đã nằm trong kỳ đã khóa thì không sửa |

Quy tắc toàn vẹn: snapshot ghi trong **cùng transaction** với `finalizeOrder` (đã có chỗ ghi COGS). Backfill đơn cũ bằng script idempotent theo tỷ lệ có hiệu lực tại `completed_at`.

### 3.3 Rollup để báo cáo nhanh

| Bảng | Cột | Ghi chú |
|---|---|---|
| `tax_daily_summary` | PK (`day`, `category_id`): `orders_count`, `gross_revenue`, `discount`, `net_revenue`, `vat_amount`, `pit_rate_revenue_amount`, `unpaid_amount`, `updated_at` | Upsert `ON DUPLICATE KEY UPDATE` trong transaction hoàn tất đơn. Kỳ quý = Σ ≤ 92 dòng × 3 nhóm |
| `tax_periods` | `id`, `kind` (`month`/`quarter`/`year`), `period_from`, `period_to`, `status` (`open`/`locked`/`filed`), `totals_json`, `locked_by`, `locked_at`, `filed_ref` | Khóa kỳ = chụp `totals_json`; số khóa là số đã nộp |
| `tax_adjustments` | `id`, `period_id`, `category_id`, `amount`, `reason`, `created_by` | Điều chỉnh sau khi khóa bằng **dòng bù**, không sửa đơn gốc |

Có lệnh `scripts/rebuild-tax-summary.js` dựng lại rollup từ `order_items` (đối chiếu hằng đêm, cảnh báo nếu lệch).

### 3.4 Sổ chi phí

Hiện chưa có bảng chi phí (chỉ có `inventory_movements` loại `purchase` khi nhập kho).

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `expenses` | `id`, `expense_date`, `doc_no`, `description`, `category` (nguyên liệu, lương, thuê mặt bằng, điện nước, khác), `amount`, `vat_included` BIT, `supplier`, `attachment_media_id` NULL, `source` (`manual`/`inventory_purchase`), `source_ref`, `created_by` | Nhập kho (`receiving`) tự sinh chi phí `source=inventory_purchase`; chi khác nhập tay trên app. Ảnh hóa đơn đầu vào dùng `media_files` có sẵn |

### 3.5 Hàng đợi xuất file

| Bảng | Cột chính |
|---|---|
| `tax_exports` | `id`, `period_id`, `kind` (`s2a_revenue`, `expense_book`, `declaration`, `bundle`), `format` (`xlsx`/`pdf`), `status` (`queued`/`running`/`done`/`failed`/`expired`), `attempts`, `file_name`, `file_bytes` BIGINT, `error`, `requested_by`, `created_at`, `started_at`, `finished_at`, `expires_at` |

Mọi thao tác khóa kỳ, xuất, điều chỉnh ghi vào `audit_log` (đã có).

---

## 4. Kiến trúc API & xuất báo cáo trên Hostinger

### 4.1 Endpoint

| Method & path | Quyền | Việc |
|---|---|---|
| `GET /api/tax/dashboard?as_of=` | admin | Doanh thu lũy kế năm, so với ngưỡng, GTGT/TNCN **dự tính** kỳ hiện tại, hạn nộp. Đọc `tax_daily_summary`, cache 30–60 s |
| `GET /api/tax/periods` | admin | Danh sách kỳ + trạng thái |
| `POST /api/tax/periods/:id/lock` | admin | Chụp số, khóa kỳ |
| `POST /api/tax/exports` | admin | Tạo job (idempotency-key), trả `202 {id}` ngay |
| `GET /api/tax/exports/:id` | admin | Trạng thái; khi `done` có `download_url` |
| `GET /api/tax/exports/:id/file` | admin | Tải file (token ký, hết hạn 15 phút) |
| `GET/POST /api/expenses` | admin | Sổ chi phí |
| `GET/PUT /api/tax/config` | admin | Nhóm thuế, bảng tỷ lệ (đổi = thêm dòng hiệu lực mới) |

Quyền `cashier` không thấy mục thuế.

### 4.2 Xử lý nặng mà không làm sập Node

1. **Không aggregation lớn lúc xuất.** Số liệu tổng đến từ `tax_daily_summary`. Chỉ **sổ chi tiết** (S2a: mỗi dòng một ngày/đơn) cần quét `orders` theo kỳ.
2. **Quét theo con trỏ khóa chính** (`WHERE id > ? ORDER BY id LIMIT 2000`), không `OFFSET`, không nạp cả kỳ vào RAM.
3. **Excel dạng streaming:** `exceljs` (đã là dependency) có `WorkbookWriter` ghi từng dòng ra file tạm; RAM ổn định vài chục MB bất kể số dòng.
4. **PDF:** ưu tiên xuất **xlsx + trang HTML in được** (như phiếu chốt ca). Nếu bắt buộc PDF, dựng từ HTML đã phân trang bằng thư viện nhẹ (thêm `pdfkit`), chạy trong **`worker_threads`** để một job PDF không chặn các request POS.
5. **Hàng đợi = chính bảng `tax_exports`**, không thêm Redis/RabbitMQ (Hostinger shared không có). Một worker trong process:
   - Poll mỗi 5 s: `UPDATE tax_exports SET status='running', started_at=NOW() WHERE status='queued' ORDER BY id LIMIT 1` rồi đọc dòng vừa nhận (an toàn khi chỉ 1 worker; với nhiều worker dùng `SELECT … FOR UPDATE SKIP LOCKED` trên MySQL 8).
   - **Đồng thời tối đa 1 job**, ngắt sau 120 s, `attempts ≤ 3`.
   - Khởi động lại: job `running` quá 5 phút → trả về `queued` (đã có mẫu tương tự ở `payonService.recoverStale`).
6. **Lưu file:** thư mục ngoài app (`TAX_EXPORT_DIR`, như `BACKUP_DIR`), vì deploy xóa thư mục app; xóa sau 7 ngày (`expires_at`). Không lưu BLOB trong MySQL.
7. **Chống lạm dụng:** rate limit `POST /exports` (vd 6/giờ/người), từ chối tạo trùng khi đã có job cùng kỳ + loại đang chạy (trả job cũ).

### 4.3 Độ đúng của số liệu

- Số trên dashboard là **dự tính** (kỳ `open`), ghi rõ "cập nhật lúc …".
- Số trên sổ/tờ khai xuất từ kỳ **`locked`**; kỳ chưa khóa xuất ra có watermark "NHÁP".
- Đối chiếu: `Σ rollup = Σ order_items.net_revenue = Σ orders.total` (đơn hoàn tất); lệch → chặn khóa kỳ và báo lỗi.

---

## 5. Luồng thao tác trên Flutter (chủ quán)

| Bước | Màn hình | Chi tiết |
|---|---|---|
| 1 | **Thuế** (tab trong Quản lý) | Thẻ "Quý này": doanh thu lũy kế, thanh tiến độ tới ngưỡng, **GTGT dự tính**, **TNCN dự tính**, hạn nộp còn N ngày. Kéo để làm mới; tự làm mới 60 s khi đang mở. Có dòng "cập nhật lúc …" |
| 2 | **Chi tiết nhóm** | Doanh thu theo nhóm thuế (đồ uống / thuốc lá), biểu đồ theo ngày của kỳ |
| 3 | **Chọn kỳ** | Chip Tháng / Quý / Năm + bộ chọn kỳ; kỳ đã khóa có biểu tượng khóa |
| 4 | **Xuất báo cáo** | Chọn loại (Sổ doanh thu S2a, Sổ chi phí, Bảng kê tờ khai, Gói tất cả) × định dạng. Bấm "Tạo file" → app nhận `202` và hiện tiến độ |
| 5 | **Theo dõi** | App hỏi `GET /exports/:id` mỗi 3 s (tăng dần tới 10 s); xong hiện nút **Tải về / Chia sẻ** (share sheet gửi kế toán qua Zalo/email). Rời màn hình vẫn giữ trong "Báo cáo đã tạo" |
| 6 | **Khóa kỳ** | Nút "Chốt kỳ" kèm xác nhận, cảnh báo nếu còn đơn đang mở hoặc chênh đối chiếu |
| 7 | **Chi phí** | Nhập nhanh chi phí + chụp ảnh hóa đơn (dùng `media_files`) |

Lưu ý với app offline-first hiện có: **chỉ tính thuế ở máy chủ**, app chỉ hiển thị; offline thì hiện số lần cuối kèm thời điểm, không tự tính cục bộ.

---

## 6. Rủi ro & chi phí

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| Luật/ngưỡng đổi tiếp (đã đổi ít nhất 2 lần trong 2026) | Cao | Bảng `tax_rates` có hiệu lực theo ngày + `legal_basis`; kế toán duyệt trước khi bật |
| Tính sai do giảm giá, đơn trộn ngành, đơn hủy/hoàn | Cao | Phân bổ giảm giá, snapshot theo dòng, đối chiếu ba chiều, bộ test dữ liệu giả lập |
| Xuất file làm hết RAM/CPU, kéo sập POS | Trung bình | Streaming, 1 job một lúc, giới hạn thời gian, PDF trong worker; theo dõi `process.memoryUsage()` và dừng nhận job khi RSS cao |
| Hostinger giới hạn tiến trình/RAM; process bị giết giữa chừng | Trung bình | Job bền trong DB, có thể chạy lại; ghi file tạm rồi đổi tên khi xong |
| Số trên app lệch số kế toán | Trung bình | "Dự tính" vs "đã khóa", tải được bảng đối chiếu theo ngày |
| Lộ dữ liệu tài chính | Trung bình | Chỉ admin, link tải ký ngắn hạn, file xóa sau 7 ngày |
| Phụ thuộc xuất PDF nặng | Thấp | Mặc định xlsx + HTML in; PDF là tùy chọn |

**Chi phí vận hành:** gần như bằng 0 thêm. Không Redis/queue ngoài; thêm ~5 bảng nhỏ (rollup dưới vài nghìn dòng/năm); file xuất dưới vài MB mỗi cái, tự xóa. Chỉ thêm chi phí nếu quán lớn hơn nhiều: khi đó tách worker ra một Node.js app thứ hai cùng DB (giữ nguyên bảng `tax_exports`).

**Nên có từ đầu:** cron đối chiếu hằng đêm, cảnh báo Zalo cho chủ quán khi lệch hoặc job thất bại (đã có `ownerNotice`).

---

## 7. Lộ trình đề xuất

| Giai đoạn | Nội dung | Ước lượng |
|---|---|---|
| 1 | `tax_categories`, `tax_rates`, gắn nhóm cho món; snapshot dòng món + rollup; dashboard dự tính | 3–4 ngày |
| 2 | Sổ doanh thu (xlsx streaming) + hàng đợi `tax_exports` + tải file; màn hình Flutter | 3–4 ngày |
| 3 | Khóa kỳ, điều chỉnh, đối chiếu hằng đêm; bảng kê tờ khai | 3 ngày |
| 4 | Sổ chi phí + ảnh hóa đơn; TNCN theo lợi nhuận | 3 ngày |
| 5 | PDF (tùy chọn) | 2 ngày |

---

## 8. Cần xác nhận với kế toán/cơ quan thuế trước khi dùng thật

1. Ngưỡng miễn thuế đang áp dụng cho quán: 500 triệu hay 1 tỷ (NĐ 141/2026 sửa NĐ 68/2026?).
2. Cách tính TNCN cho nhóm 500 triệu – 3 tỷ: theo tỷ lệ trên doanh thu hay theo lợi nhuận; số trừ 500 triệu áp dụng thế nào.
3. Quán thuộc nhóm sổ nào của TT 152/2025 và cần những sổ nào (S2a-HKD chắc chắn; còn lại tùy nhóm).
4. Mẫu tờ khai quý hiện hành (mã mẫu, cách ghi hai nhóm ngành trên cùng một tờ khai) và việc nộp qua cổng Thuế điện tử.
5. Nghĩa vụ hóa đơn điện tử/khởi tạo từ máy tính tiền ở mức doanh thu của quán, và có phải bỏ dòng "VAT 8%" trên hóa đơn không.
6. Thuốc lá bán lại: nhóm "phân phối hàng hóa" 1%/0,5% có đúng, hay có quy định riêng.

**Nguồn tra cứu (trang tư vấn, chưa phải văn bản gốc):**
- TT 152/2025/TT-BTC: [MISA eShop](https://www.misaeshop.vn/?p=35987), [Sapo](https://www.sapo.vn/blog/thong-tu-152-2025-tt-btc)
- Cách tính thuế HKD 2026: [thuvienphapluat](https://thuvienphapluat.vn/phap-luat-doanh-nghiep/bai-viet/chi-tiet-cach-tinh-thue-ho-kinh-doanh-nho-le-2026-16192.html), [einvoice.vn](https://einvoice.vn/tin-tuc/thue-ho-kinh-doanh-2026)
- Kỳ kê khai, NĐ 68/2026 và NĐ 141/2026: [fastca.vn](https://fastca.vn/ke-khai-thue-ho-kinh-doanh-quy-i-2026)
