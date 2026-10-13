# CoCoffee F&B — Đặc tả UI/UX (Web Admin + Tablet POS Flutter)

| | |
|---|---|
| Phiên bản | 1.0 · 13/10/2026 |
| Đối tượng | Web Admin: quản lý / chủ quán · Tablet POS: thu ngân (Android 10–11", landscape) |
| Nguồn token | [`design-tokens.json`](design-tokens.json) (một nguồn cho CSS variables và Flutter `ThemeData`) |
| Backend hiện có | REST `/api/*` + Zalo webhook (xem mục 5 để biết cái gì dùng được ngay, cái gì còn thiếu) |

**Nguyên tắc xuyên suốt:** (1) Mỗi màn hình có đúng một hành động chính (nút amber). (2) Mọi thao tác thường gặp ≤ 2 chạm. (3) Không modal chặn thu ngân — thông báo Zalo đi qua toast + hộp thư. (4) Màu không bao giờ là tín hiệu duy nhất (luôn kèm icon/chữ). (5) Phẳng: không đổ bóng, phân tách bằng khoảng trắng + viền 1dp.

---

## Phần 1 — Báo cáo tối ưu UX từ đối thủ

### 1.1 Ba điểm chạm được cải tiến

| # | Điểm chạm | Học từ | Cải tiến áp dụng | Trước | Sau | Tiết kiệm |
|---|---|---|---|---|---|---|
| T1 | **Thêm món** | Square / Toast: lưới lớn, một chạm là thêm | Chạm ô sản phẩm = +1 ngay vào giỏ, **không mở hộp thoại**. Ghi chú/số lượng chỉnh **tại dòng giỏ hàng** (stepper + chip "ít đá", "ít đường", "ít ngọt") — chỉ khi cần | 3 chạm / món (chọn → hộp thoại SL/ghi chú → Thêm) ≈ 2,8 s | 1 chạm ≈ 0,8 s | **2,0 s/món** → ≈ 4,8 s/đơn (2,4 món/đơn) |
| T2 | **Mở bàn → gọi món** | iPOS / KiotViet F&B: sơ đồ bàn theo màu trạng thái, thao tác bàn bằng cử chỉ | Chạm bàn **trống** = vào ngay màn gọi món đã gắn bàn; đơn chỉ được tạo ở **món đầu tiên** (không sinh đơn rỗng). Chạm bàn **có khách** = mở đúng đơn đang phục vụ. Chuyển/gộp bàn bằng **kéo-thả** thẻ bàn | 4 chạm (tab Bàn → chọn bàn → "Mở bàn?" → tab Món) ≈ 3,6 s | 1 chạm ≈ 0,8 s | **2,8 s/đơn**; chuyển/gộp bàn: 5 chạm → 1 cử chỉ (≈ 3,5 s) |
| T3 | **Thanh toán** | Square: checkout ít chạm, gợi ý mệnh giá, nhớ lựa chọn gần nhất | Phương thức mặc định = lần dùng gần nhất. Nút **[Đủ tiền]** + chip mệnh giá làm tròn lên (50k/100k/200k/500k), **tiền thối hiện cỡ lớn**; không hộp thoại in (hoá đơn Zalo tự gửi, in là tuỳ chọn) | 7 chạm (Thanh toán → phương thức → numpad ~4 chạm → xác nhận → hộp thoại in) ≈ 6,5 s | 2 chạm ≈ 1,8 s | **4,7 s/đơn** |

**Tổng thời gian chạm mỗi đơn: ≈ 16,8 s → ≈ 4,5 s (giảm ≈ 12,3 s, −73 %).**
Phần "Sapo F&B" (kho nguyên liệu + định mức) được áp dụng ở Web Admin: Phần 2.3.

### 1.2 Giả định và cách đo (để không tin vào ước tính)

- Mô hình: 1 chạm có phản hồi ≈ 0,8 s; đọc/tìm ≈ 1,0 s; 2,4 món/đơn. **Đây là ước tính thiết kế, chưa phải số đo.**
- Đo thật bằng sự kiện ghi trên app: `table_tap → first_item_added`, `first_item_added → checkout_start`, `checkout_start → paid`. Mục tiêu p50 ≤ 5 s cho T2+T3 cộng lại; theo dõi p90 để phát hiện thu ngân bị kẹt.
- Kiểm thử: 5 thu ngân × 10 đơn mẫu trước/sau, quay màn hình, đếm chạm.

---

## Phần 2 — Layout Web Admin (Quản lý / Chủ quán)

### 2.1 Khung tổng thể (tham chiếu 1440×900, tối thiểu 1024)

```
┌──────────────┬───────────────────────────────────────────────────────────────────────────┐
│ ☕ CoCoffee   │ Kho & Định mức › Công thức       🔍 Tìm nhanh ⌘K    ● Zalo OK   🔔 3   AD ▾ │ HEADER 64
│              ├───────────────────────────────────────────────────────────────────────────┤
│ ▣ Tổng quan  │  H1 Tiêu đề trang                                [Phụ] [CTA chính ●amber] │
│ ▦ Bàn        │  ─ thanh lọc / tab (tuỳ trang) ────────────────────────────────────────── │
│ ☕ Thực đơn   │                                                                           │
│ ⚖ Kho        │   MAIN CONTENT                                                            │
│   · Nguyên liệu                                                                          │
│   · Công thức│   max-width 1280 · lưới 12 cột · gutter 24 · padding 24                   │
│   · Nhập kho │                                                                           │
│ 🧾 Đơn hàng  │                                                                           │
│ 📈 Báo cáo   │                                                                           │
│ 💬 Zalo OA   │                                                                           │
│ ⚙ Cài đặt    │                                                                           │
│ ‹ thu gọn    │                                                                           │
└──────────────┴───────────────────────────────────────────────────────────────────────────┘
   SIDEBAR 240 (thu gọn 72, chỉ icon + tooltip)
```

| Vùng | Quy cách |
|---|---|
| **Sidebar** 240px, nền `bg.base` tối cả ở light theme | Nhóm theo module backend: Tổng quan · Bàn · Thực đơn (Sản phẩm, Danh mục) · Kho (Nguyên liệu, **Công thức/BOM**, Nhập kho, Kiểm kê) · Đơn hàng (POS / Zalo) · Báo cáo (Doanh thu, Giá vốn & Lãi gộp) · Zalo OA (Phiên chat, Sự kiện, Trạng thái token) · Cài đặt (Nhân viên, Quyền). Mục đang chọn: vạch trái 3px `accent.amber` + chữ `text.primary`. Item cao 48px |
| **Header** 64px sticky | Trái: breadcrumb. Giữa/phải: tìm nhanh (⌘K: món, đơn, nguyên liệu), **chấm trạng thái Zalo** (xanh = token còn hạn & webhook nhận được; đỏ = cần cấp quyền lại), chuông (cảnh báo tồn thấp, bill Zalo gửi lỗi), menu người dùng (đổi mật khẩu, đăng xuất) |
| **Main** | Page header (H1 + tối đa 1 CTA amber + nút phụ viền) → thanh lọc → nội dung. Không lồng card trong card; bảng dòng cao 56px, **số căn phải, font mono**, hover `bg.surface`, không zebra |
| **Dashboard** | Dải KPI 4 ô: Doanh thu · Giá vốn · Lãi gộp · Đơn Zalo chờ thu (API `GET /orders/summary`, `GET /orders?source=zalo`). Dưới: tồn thấp (`GET /inventory?low=1`), đơn gần đây |

### 2.2 Cách tổ chức để màn hình dữ liệu không rối

1. Một mức nhấn: chỉ CTA chính dùng amber; trạng thái dùng matcha/danger; còn lại trung tính.
2. Bảng ≤ 6 cột hiển thị mặc định; cột phụ ẩn sau "Cột ▾".
3. Hành động theo dòng nằm trong menu `⋯`, không rải nút.
4. Bộ lọc dạng chip phía trên bảng, có đếm số (`Thiếu định mức 2`).

### 2.3 Màn hình "Thiết lập định mức nguyên liệu (Recipe/BOM)"

Master–detail 3 vùng: **danh sách món (320) · trình soạn công thức (linh hoạt) · tóm tắt giá vốn dính (320)**. Định lượng và giá vốn trong hình lấy từ `database/seed.sql`; số tồn kho chỉ để minh hoạ.

```
┌ MÓN ──────────────────┬ CÔNG THỨC · Cà phê sữa đá ─────────────────────┬ GIÁ VỐN / LY ───────────┐
│ 🔍 Tìm món…            │ ◉ Pha chế theo công thức   ○ Bán trực tiếp 1:1  │   8.340đ                │
│ [Tất cả][Thiếu CT 0]   │ ───────────────────────────────────────────── │ Giá bán        25.000đ  │
│ [Biên thấp 0]          │ Nguyên liệu              Định lượng   Thành tiền │ Lãi gộp   16.660đ 66,6% │
│ ────────────────────── │ ───────────────────────────────────────────── │ Food cost       33,4%   │
│ ▌Cà phê sữa đá   33% ▮▮│ Cà phê rang xay          [ 18  ] g     5.040đ  ✕│ ▮▮▮▯▯▯▯ ≤35% tốt        │
│  Cà phê đen đá   32% ▮▮│  280đ/g · tồn 4.954 g                          │                         │
│  Bạc xỉu         26% ▮ │ Sữa đặc                  [ 30  ] g     2.100đ  ✕│ CƠ CẤU GIÁ VỐN          │
│  Trà đào         33% ▮▮│  70đ/g · tồn 3.915 g                           │ ████████████▒▒▒▒▒░░ ·   │
│  Trà đá          26% ▮ │ Ly nhựa + nắp            [ 1   ] pcs     900đ  ✕│ ■ Cà phê  60%           │
│  ── Thuốc lá ──        │  900đ/pcs · tồn 497 pcs                        │ ■ Sữa đặc 25%           │
│  Thuốc 555    1:1      │ Đá viên                  [ 150 ] g       300đ  ✕│ ■ Ly      11%           │
│                        │  2đ/g · tồn 39.550 g                           │ ■ Đá       4%           │
│                        │ ＋ Thêm nguyên liệu                             │                         │
│                        │ ▸ Nâng cao (hao hụt %, đơn vị thay thế, ghi chú)│                         │
├────────────────────────┴────────────────────────────────────────────────┴─────────────────────────┤
│ ● Chưa lưu · Giá vốn 8.340đ → 8.640đ (+300đ)                          [ Huỷ thay đổi ] [ Lưu ●amber ] │ sticky 72
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Quyết định thiết kế | Lý do |
|---|---|
| **4 thông tin mỗi dòng** (tên · định lượng+đơn vị · thành tiền · xoá). Đơn giá/đv và tồn kho là chữ phụ xám dưới tên, không phải cột | Giữ bảng ngắn, quét một mắt. Vẫn thấy ngay "Ly nhựa" tốn 900đ/ly |
| Dòng sắp theo **thành tiền giảm dần** | Nguyên liệu đáng chú ý nằm trên cùng |
| **Thanh cơ cấu giá vốn** (xếp chồng, top 4 + "Khác") và gauge food cost (≤ 35 % matcha, 35–45 % amber, > 45 % danger — ngưỡng chỉnh được) | Nhìn là biết kéo giá vốn xuống ở đâu — phần Sapo F&B làm tốt nhất |
| **Thêm nguyên liệu**: combobox gõ-để-tìm, mỗi kết quả hiện đơn vị gốc + tồn + giá vốn; `Enter` thêm dòng và nhảy sang ô định lượng; `Tab` đi dòng kế | Nhập 6 nguyên liệu không cần chuột |
| **Đa đơn vị tính (UI)**: nhập theo `kg`/`l`/`thìa`/`shot` rồi **quy đổi về đơn vị gốc** (g/ml/pcs) khi lưu; đơn vị gốc luôn hiển thị | Backend lưu theo đơn vị gốc (`recipes.quantity`); bảng quy đổi riêng là việc Phase 2 |
| **Chế độ "Bán trực tiếp 1:1"** (thuốc lá, nước chai): thay trình soạn bằng một ô chọn mặt hàng kho | Khớp `stock_mode = direct` — không bắt chọn công thức vô nghĩa |
| "Nâng cao" thu gọn mặc định | Tiết lộ dần; 90 % món không cần |
| Thanh lưu dính đáy hiện **chênh lệch giá vốn** trước/sau; cảnh báo vàng khi nguyên liệu tồn thấp; chặn lưu khi trùng dòng hoặc định lượng ≤ 0 | Thấy hệ quả trước khi lưu |
| Danh sách trái: chip lọc **Thiếu định mức** / **Biên thấp**; thanh mini food-cost mỗi món | Việc cần làm nổi lên trên cùng |

API: `GET /products`, `GET /products/:id` (kèm `recipe`), `PUT /products/:id` với `recipe[]`, `GET /inventory`.

---

### 2.4 Responsive và layout riêng cho điện thoại (đã triển khai trong `views/`)

Thiết bị được nhận diện bằng media query (độ rộng + `pointer: coarse`) và thuộc tính `data-device` do JS đặt khi tải và khi xoay màn hình — không đọc user-agent.

| Tier | Độ rộng | Điều hướng | Header | Bảng công thức | Hộp thoại |
|---|---|---|---|---|---|
| **Phone** | < 768 | **Thanh tab dưới 56px** (Tổng quan · Định mức · Menu) + drawer; vuốt trái để đóng; nền sau drawer `inert` | 56px: logo, tiêu đề trang, chấm Zalo, chuông | Mỗi dòng là một **thẻ**: tên + % lợi nhuận, chip nguyên liệu, giá vốn | giá bán, nút Sửa/Xóa cao 44px | **Bottom sheet**, nút Hủy/Lưu dính đáy |
| **Tablet** | 768–1023 | Rail 72px (icon) | 64px | Lưới thẻ **2 cột** | Modal giữa màn hình |
| **Laptop** | 1024–1279 | Rail mặc định, mở rộng được | 64px | Bảng đầy đủ | Modal |
| **Desktop** | ≥ 1280 | Sidebar 240px, thu gọn được, **nhớ lựa chọn** (chỉ áp dụng từ 1024 trở lên) | 64px | Bảng đầy đủ, nội dung tối đa 1280px | Modal |

Thao tác trên điện thoại: thanh tab phân đoạn và ô tìm kiếm **dính** dưới header; nút "+" và "Nhập Excel" nằm trong thanh công cụ dính (không dùng nút nổi vì nó che nút Xóa của thẻ); ô nhập ≥ 16px (iOS không tự phóng to); vùng chạm ≥ 44px khi `pointer: coarse`; tôn trọng safe-area (tai thỏ, thanh home); `touch-action: manipulation` bỏ trễ chạm đúp.

## Phần 3 — Layout Tablet POS (Thu ngân)

### 3.1 Nền tảng và lưới

- Tham chiếu **1280×800dp landscape** (tối thiểu 960×600; portrait: giỏ hàng thành bottom sheet).
- Lưới nền 8dp · lề an toàn 16dp · **vùng chạm ≥ 48×48dp** (nút chính 56dp, CTA thanh toán 64dp, khoảng cách giữa hai vùng chạm ≥ 8dp).

**Màn "Gọi món"** (1280dp):

```
┌────┬────────────────────────────────────────────────────────────────────────────────────────┐
│    │ TOP BAR 56 · ☕ CoCoffee   [🪑 Bàn 5 · CF261013-00042]        🔍   ⟳ Online  14:05    │
│ 72 ├───────┬───────────────────────────────────────────────┬────────────────────────────────┤
│RAIL│ DANH  │ LƯỚI SẢN PHẨM            (692dp ≈ 54 %)         │ GIỎ HÀNG                (380dp) │
│    │ MỤC   │ ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐       │ Bàn 5 · 3 món        [Đổi bàn]  │
│ 🪑 │ 136   │ │Cà phê││Cà phê││ Bạc  ││ Trà  ││ Trà  │       │ ───────────────────────────────  │
│ Bàn│       │ │sữa đá││đen đá││ xỉu  ││ đào  ││ đá   │       │ Cà phê sữa đá   − 2 +   50.000   │
│    │ ★ Hay │ │25.000││20.000││29.000││35.000││ 8.000│       │   [ít đá][ít đường]              │
│ 🛒 │  gọi  │ └──────┘└──────┘└──────┘└──────┘└──────┘       │ Bạc xỉu         − 1 +   29.000   │
│Gọi │ ☕ Pha │ ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐       │                                  │
│món │  chế  │ │Thuốc ││Marl- ││Thăng ││Aqua- ││Lavie │       │ ───────────────────────────────  │
│    │ 🚬 Thuốc│ │ 555  ││boro  ││ Long ││fina  ││ 500ml│       │ Tạm tính              79.000đ    │
│ 🧾 │ 💧 Nước│ └──────┘└──────┘└──────┘└──────┘└──────┘       │ Giảm giá                  0đ    │
│Đơn │       │   ô sản phẩm 122×122 (5 cột)                    │ TỔNG CỘNG             79.000đ    │
│    │       │                                                │ ┌────────────────────────────┐ │
│ 💬 │       │                                                │ │  THANH TOÁN   79.000đ  ●64 │ │
│Zalo│       │                                                │ └────────────────────────────┘ │
│ 🔴2│       │                                                │ [Lưu & thoát]     [Huỷ đơn]    │
└────┴───────┴───────────────────────────────────────────────┴────────────────────────────────┘
```

| Vùng | Rộng (dp) | Tỷ lệ | Hành vi |
|---|---|---|---|
| **Rail** (Bàn · Gọi món · Đơn · Zalo + badge · Cài đặt) | 72 | 5,6 % | Luôn hiện; icon 48dp + nhãn 12sp; badge Zalo là chấm số amber |
| **Danh mục** | 136 | 10,6 % | Cuộn dọc; nút 136×56; mục đầu **★ Hay gọi** (8 món bán chạy, tính trên máy) |
| **Lưới sản phẩm** | 692 (linh hoạt) | 54 % | 5 cột × ô 122dp (min 120), khoảng cách 12; tên tối đa 2 dòng, giá chữ mono; chạm = +1; **badge số lượng** góc trên-phải khi đã có trong giỏ; ô hết hàng mờ + nhãn "Hết" |
| **Giỏ hàng** | 380 | 29,7 % | Dòng cao 64dp: stepper −/+ 48dp; **vuốt trái = xoá** (snackbar hoàn tác 4 s); tổng + CTA dính đáy |
| Top bar | cao 56 | | Chip bàn/đơn, tìm kiếm, trạng thái đồng bộ, giờ |

**Màn "Bàn"** (trang chủ): Rail 72 · bộ lọc trạng thái 136 · **sơ đồ bàn** 692 (4 cột thẻ 148×112) · xem nhanh đơn 380.

```
┌ BÀN ─────────────────────────────────────────────────────────────┐
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│ │○ Bàn 1      │ │● Bàn 2   ⬡ │ │● Bàn 3      │ │○ Bàn 4      │  │
│ │ Trống · 4   │ │ 79.000đ     │ │ 145.000đ    │ │ Trống · 4   │  │
│ │ matcha viền │ │ ⏱ 06:12    │ │ ⏱ 21:40 ⚠  │ │             │  │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘  │
│  ○ trống   ● có khách (amber)   ⚠ chờ lâu ≥ 15' (đỏ, viền 2dp)    │
│  ⬡ có đơn Zalo   Kéo thẻ A lên thẻ B = Gộp · Giữ lâu = Chuyển/Tách│
└──────────────────────────────────────────────────────────────────┘
```

| Trạng thái bàn | Nguồn dữ liệu | Hiển thị |
|---|---|---|
| **Trống** | `status = available` | Viền matcha 2dp, nền `bg.surface`, icon ○, "Trống · sức chứa" |
| **Có khách** | `status = serving`, tuổi đơn < 15' | Nền `status.amberTint`, viền amber, icon ●, tổng tiền + đồng hồ mono |
| **Chờ lâu** (đang chờ món) | `serving`, tuổi đơn ≥ 15' (cấu hình được) — **suy ra trên app**, backend chưa có trạng thái pha chế | Viền `status.danger` 2dp + icon ⚠; nhịp nhấp nháy nhẹ 1 lần/2 s (tắt khi bật "giảm chuyển động") |
| Đơn Zalo | `order.source = zalo` | Huy hiệu ⬡ Zalo góc phải thẻ; đơn Zalo không gắn bàn nằm ở làn "Mang đi / Zalo" cuối sơ đồ |

Thao tác: chạm = mở bàn/đơn · giữ lâu = menu (Chuyển bàn, Gộp bàn, Tách đơn, Huỷ) · kéo-thả = gộp. *Chuyển/Gộp/Tách cần API Phase 2 (mục 5).*

### 3.2 Thanh toán (Frictionless checkout)

Bảng thanh toán trượt từ **phải, rộng 520dp, phủ vùng sản phẩm, để lộ dòng Tổng của giỏ**:

```
┌ THU TIỀN · Bàn 5 ───────────────── ✕ ┐
│        Cần thu                         │
│       79.000đ   (mono 32sp)            │
│ [ Tiền mặt ◉ ][ Chuyển khoản ][ Thẻ ]  │  ← nhớ lần dùng gần nhất
│ ┌────────────────────────────────────┐ │
│ │        ĐỦ TIỀN   79.000đ    ●64dp │ │  ← 1 chạm = xong
│ └────────────────────────────────────┘ │
│  [ 80k ] [ 100k ] [ 200k ] [ 500k ]    │  ← làm tròn lên từ 79.000
│  Tiền thối   21.000đ  (cỡ lớn)         │
│  ▸ Giảm giá · Mã tham chiếu CK         │
└────────────────────────────────────────┘
```
Thành công: dấu ✓ matcha 1,2 s rồi về sơ đồ bàn; bàn tự trống. API: `POST /orders/:id/pay {method, tendered, discount?, reference?}`.

### 3.3 Luồng xử lý UI khi Draft Order từ Zalo "nổ" về POS

**Dòng thời gian (thu ngân không phải làm gì để đơn chạy được):**

```
Khách Zalo                 Máy chủ                                  Tablet POS
 "2 cf sữa, 1 bạc xỉu" ──▶ tạo DRAFT, gửi tóm tắt "nhắn ok"
                           ── poll 5 s: GET /orders?source=zalo&status=draft ──▶ ① TOAST xanh Zalo + badge rail
 "ok" ───────────────────▶ 1 giao dịch: draft→completed, trừ kho, giá vốn;
                           gửi hoá đơn cho khách
                           ── poll thấy completed + unpaid ───────────────────▶ ② TOAST matcha "Khách đã xác nhận"
                                                                                   [Thu tiền] → ③ POST /orders/:id/pay
```

**Máy trạng thái của một thẻ Zalo trong Hộp thư:**

```
 DRAFT ⏱30:00 ──khách "ok"──▶ ĐÃ XÁC NHẬN · CHƯA THU ──thu tiền──▶ ĐÃ THU
   │  ├─ hết hạn ───────────▶ HẾT HẠN (mờ, tự ẩn sau 60 s)
   │  └─ khách "huy"/thu ngân huỷ ▶ ĐÃ HUỶ
 ĐÃ XÁC NHẬN + receipt_error ──▶ chip đỏ "Chưa gửi bill" [Gửi lại]
```

**① Toast "Đơn Zalo mới" (không gián đoạn):**

```
┌──────────────────────────────────────────────┐ 360×88dp · radius 12 · nền bg.elevated
│▌⬡ Đơn Zalo mới · Khách …4821          ⏱ 29:41 │ ▌= vạch 4dp channel.zalo
│▌ 2× Cà phê sữa đá, 1× Bạc xỉu                 │
│▌ 79.000đ · chờ khách xác nhận   [ Xem ] [ ✕ ] │ nút 48dp
└──────────────────────────────────────────────┘
```

| Thuộc tính | Quy định |
|---|---|
| Vị trí | Góc **trên-phải vùng nội dung**, dưới top bar (cách mép 16dp) — **không che CTA Thanh toán, numpad, ô nhập** |
| Tính chất | Không modal, không scrim, **không cướp focus/bàn phím**; vuốt ngang để tắt |
| Thời gian | 8 s tự ẩn (chạm vào thì giữ); luôn còn trong Hộp thư |
| Xếp chồng | Tối đa 2 toast; từ đơn thứ 3 gộp thành "＋N đơn Zalo mới" |
| **Đang thu tiền / đang nhập** | Bảng thanh toán hoặc numpad mở ⇒ **không hiện toast**, chỉ tăng badge; hiện lại khi thu ngân đóng bảng |
| Âm thanh/rung | Một tiếng chuông ngắn ≤ 0,6 s + rung nhẹ, theo chế độ chuông của máy; tắt được; chỉ phát ở màn Bàn/Gọi món |
| Hỗ trợ tiếp cận | Thông báo `polite` (không `assertive`); chữ ≥ 14sp |
| Danh tính khách | Backend chỉ có `zalo_user_id` ⇒ hiện "Khách …4821" (4 số cuối); tên thật cần API hồ sơ Zalo (mục 5) |

**② Hộp thư Zalo (ngăn kéo 400dp):** mở từ icon Zalo ở rail hoặc nút **Xem**; trượt từ phải phủ **vùng sản phẩm — giỏ hàng vẫn hiện**, nên đơn thu ngân đang gõ không bị mất ngữ cảnh. Không tự mở.

| Trạng thái thẻ | Diện mạo | Hành động |
|---|---|---|
| **Draft** | Viền nét đứt amber, đồng hồ đếm ngược, dòng "Chưa trừ kho" | **Xem** (chi tiết chỉ đọc) · **Huỷ** |
| **Đã xác nhận · chưa thu** | Viền liền, vạch Zalo, chip matcha "Khách đã xác nhận" | **Thu tiền** (CTA amber) · In phiếu pha chế |
| **Chưa gửi bill** | Chip đỏ | **Gửi lại** (`POST /orders/:id/resend-receipt`) |
| **Hết hạn / Đã huỷ** | Mờ, gạch ngang | Tự ẩn 60 s |

**Quy tắc "không cắt ngang":** (1) không modal; (2) không đổi màn hình hay giỏ hiện tại; (3) không tự chuyển focus; (4) một chạm xử lý được việc phổ biến nhất (Thu tiền); (5) hai người cùng thao tác một đơn: máy chủ phân xử bằng khoá dòng, người thua nhận thông báo "Khách vừa xác nhận / đơn đã đổi trạng thái" thay vì lỗi.

**Trường hợp biên:** mất mạng ⇒ thanh vàng "Ngoại tuyến" + giữ hộp thư đã tải; webhook gửi lại cùng sự kiện ⇒ máy chủ đã khử trùng (`zalo_events.event_key`), UI không thấy trùng; hết nguyên liệu khi khách "ok" ⇒ bot báo khách, đơn **vẫn là draft** (thẻ giữ nguyên cho đến khi khách sửa/huỷ hoặc hết hạn); POS chưa có cảnh báo riêng cho tình huống này (mục 5).

---

## Phần 4 — Design Tokens

**Concrete Dark** (mặc định POS; sidebar Admin) và **Concrete Light** (nội dung Admin, hoặc POS khi quán rất sáng). Tỷ lệ tương phản tính theo WCAG 2.x (AA chữ thường ≥ 4,5; thành phần UI ≥ 3).

### 4.1 Màu — Concrete Dark

| Token | HEX | Dùng cho | Tương phản |
|---|---|---|---|
| `bg.base` | `#1B1D1F` | Nền app | text.primary: **14,99** |
| `bg.surface` | `#25282B` | Thẻ, bảng, ô sản phẩm | text.primary: **13,14** |
| `bg.elevated` | `#2F3337` | Toast, bảng trượt, menu | text.primary: **11,29** |
| `border.subtle` | `#3D4247` | Đường phân tách 1dp | trang trí |
| `border.strong` | `#6B737A` | Viền input/nút phụ | **3,08** trên surface |
| `text.primary` | `#F4F1EA` | Chữ chính (trắng ấm, tránh loá) | — |
| `text.secondary` | `#B9BEC3` | Chữ phụ | **7,92** |
| `text.muted` | `#8A9097` | Gợi ý, nhãn phụ | **4,60** |
| `accent.amber` | `#F2A33A` | **CTA**, "có khách", focus ring | chữ `#1B1D1F` trên amber: **8,11** |
| `accent.amberPressed` | `#D98B1F` | Trạng thái nhấn | chữ tối: 6,17 |
| `accent.espresso` | `#7A5236` | Chip danh mục đang chọn, nút phụ nhấn mạnh | chữ `#F4F1EA`: **6,03** |
| `accent.espressoLine` | `#B8865F` | Viền chip espresso | 4,67 trên surface |
| `status.matcha` | `#8DB36B` | Bàn trống, đã thu, thành công | chữ `#14210F` trên matcha: **7,01** |
| `status.danger` | `#EE6C59` | Chờ lâu, lỗi, huỷ | chữ `#1B1D1F` trên danger: **5,57**; danger trên surface: 4,89 |
| `channel.zalo` | `#4C9AFF` | Nhận diện kênh Zalo (vạch, huy hiệu) | chữ `#0B1B33` trên zalo: **6,05** |
| Tint nền trạng thái | matcha `#24331F` · amber `#3A2C14` · danger `#3D1F1B` · zalo `#1A2B45` | Nền thẻ trạng thái | accent trên tint: 5,0–6,5 |

### 4.2 Màu — Concrete Light

| Token | HEX | Ghi chú tương phản |
|---|---|---|
| `bg.base` / `bg.surface` / `bg.elevated` | `#ECEAE5` / `#FFFFFF` / `#F6F4F0` | text.primary `#1F2123`: 13,44 / 16,15 |
| `border.subtle` / `border.strong` | `#D3D0CA` / `#7A8189` | strong trên surface: 3,94 |
| `text.primary` / `secondary` / `muted` | `#1F2123` / `#4A5056` / `#5F666D` | trên trắng: 16,15 / 8,16 / 5,82 |
| `accent.amber` (+pressed) | `#A35F00` (`#8A5000`) | chữ trắng trên amber: **5,01** |
| `accent.espresso` | `#6B4429` | chữ trắng: 8,45 |
| `status.matcha` / `danger` | `#3F6B2B` / `#B3261E` | chữ trắng: 6,27 / 6,54 |
| `channel.zalo` | `#0057D9` | chữ trắng: 6,24 |
| Tint | matcha `#E1EDD6` · amber `#F8E7CC` · danger `#F8DAD6` · zalo `#D9E8FF` | **Quy tắc:** trên nền tint luôn dùng `text.primary`; màu nhấn chỉ cho viền/icon (amber trên tint amber = 4,12, không dùng cho chữ) |

Quy tắc chung: màu nhấn chiếm ≤ 10 % diện tích; một màn chỉ có **một** nút amber đặc; trạng thái bàn = **màu + icon + chữ**.

### 4.3 Typography — Times New Roman (quyết định của chủ dự án)

| Vai trò | Font |
|---|---|
| Toàn bộ UI: tiêu đề, nội dung, **số tiền, số lượng, đồng hồ, số bàn** | **Times New Roman** (dự phòng: Times, Liberation Serif, Tinos, serif). Font hệ thống: không phải tải, đủ dấu tiếng Việt; chữ số cố định bề rộng nên cột tiền vẫn thẳng hàng và tổng tiền đổi giá trị không làm layout nhảy |

| Style | sp / dòng | Weight | Dùng cho |
|---|---|---|---|
| `display` | 32 / 40 | 700 | Tiêu đề lớn Admin |
| `h1` | 24 / 32 | 600 | Tiêu đề trang, tiêu đề bảng |
| `h2` | 20 / 28 | 600 | Nhóm, tên bàn |
| `bodyL` | **18 / 26** | 400 | **Mặc định trên POS** (nhìn xa, tay bận) |
| `body` | 16 / 24 | 400 | Admin, bảng |
| `label` | 14 / 20 | 600 | Nút, chip, tiêu đề cột |
| `caption` | 13 / 18 | 500 | Chữ phụ (sàn tối thiểu **13sp**) |
| `numTotal` | 32 / 40 | 600 | Tổng cần thu, tiền thối |
| `numL` / `num` / `timer` | 20 / 16 / 14 | 500 | Giá ô sản phẩm, dòng giỏ, đồng hồ |

**Lưu ý đọc được:** Times New Roman có chiều cao chữ thường thấp hơn font không chân, nên cùng cỡ trông nhỏ hơn khoảng 10 %. Để bù: nội dung bảng dùng 14–16 px, nhãn 11–12 px chỉ cho chú thích phụ, độ đậm ≥ 500 cho nhãn, tương phản chữ chính giữ ≥ 7:1. Nếu thử trên máy POS thấy khó đọc dưới ánh sáng mạnh, tăng cỡ cơ sở thay vì đổi màu.

Font hệ thống nên không cần đóng gói; riêng app Flutter trên Android cần khai báo font dự phòng (Liberation Serif/Tinos) nếu máy không có Times New Roman. Kiểm tra đủ glyph `đ Đ ư ơ ế ặ` trên thiết bị thật trước khi phát hành.

### 4.4 Token khác

| Nhóm | Giá trị |
|---|---|
| Spacing | 4 · 8 · 12 · 16 · 24 · 32 |
| Radius | 8 (chip, input) · 12 (ô, nút, thẻ) · 16 (bảng trượt) |
| Viền | 1dp mặc định · 2dp nhấn (trạng thái bàn) · **focus ring 2dp `accent.amber`, offset 2dp** |
| Vùng chạm | min **48** · chính 56 · CTA 64 · khoảng cách ≥ 8 |
| Chuyển động | 120 / 200 / 300 ms, `cubic-bezier(0.2,0,0,1)`; `reduce motion` ⇒ chỉ fade 120 ms, tắt nhấp nháy/trượt |
| Đổ bóng | Không dùng; phân lớp bằng `bg.base → surface → elevated` + viền 1dp |

Flutter: map `design-tokens.json` → `ColorScheme.dark/light` + `TextTheme`; số dùng `TextStyle(fontFamily: 'IBMPlexMono', fontFeatures: [FontFeature.tabularFigures()])`. Web: sinh CSS variables `--bg-base`, `--text-primary`… từ cùng file.

---

## Phần 5 — Ánh xạ API và khoảng trống backend

| Tính năng UI | Dùng được ngay | Cần bổ sung (Phase 2) |
|---|---|---|
| Sơ đồ bàn | `GET /tables` (kèm `current_order_total`) | Khu vực; trạng thái pha chế để có "đang chờ món" thật |
| Mở bàn + gọi món | `POST /orders {table_id, items}`; `PUT /orders/:id/items` (thay toàn bộ giỏ, có `note`) | Khoá idempotency để chống gửi trùng khi mạng chập chờn |
| Thanh toán | `POST /orders/:id/pay` (đủ tiền, có thối, giảm giá) | **Thanh toán từng phần, tách/gộp/chuyển bàn** (hiện chỉ thu đủ một lần) |
| Hộp thư Zalo | `GET /orders?source=zalo&status=draft` · `status=completed` (lọc `payment_status=unpaid` ở client) · `GET /orders/:id` lấy món | `include=items` và `updated_after` để poll nhẹ; **SSE/FCM push**; **tên khách Zalo** (API hồ sơ người dùng) |
| Huỷ draft | `POST /orders/:id/cancel` | **Báo cho khách Zalo** khi thu ngân huỷ; cho sửa món draft (`PUT items` hiện chỉ nhận đơn `open`) |
| Gửi lại bill | `POST /orders/:id/resend-receipt`; `receipt_sent_at` / `receipt_error` có trong danh sách đơn | — |
| Chấm trạng thái Zalo ở header | Chưa có | `GET /api/zalo/status`: tuổi token, lần webhook gần nhất, số sự kiện `failed` |
| Cảnh báo "hết nguyên liệu" trên thẻ draft | Chưa có (chỉ kiểm khi khách "ok") | `GET /orders/:id/availability` để thu ngân thấy trước |
| Định mức | `GET/PUT /products/:id` (`recipe[]`), `GET /inventory` | Bảng quy đổi đơn vị, % hao hụt, nhân bản công thức |
| Ô "Hết hàng" | Client tự tính từ tồn kho + công thức | Trường `available_qty` do server trả |
| Báo cáo | `GET /orders/summary` (doanh thu · giá vốn · lãi gộp · chưa thu) | Theo món, theo giờ, theo kênh |

Realtime trên shared hosting (Passenger): **dùng polling 5 s** (WebSocket thường không ổn định); FCM data-message là đường nâng cấp để toast tức thì khi app ở nền.
