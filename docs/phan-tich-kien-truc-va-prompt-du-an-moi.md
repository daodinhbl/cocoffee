# Phân tích kiến trúc CoCoffee / POS Tasotek và prompt cho dự án tiếp theo

Tài liệu này gồm hai phần: (A) kiến trúc đã triển khai và lý do, (B) một prompt mẫu để giao cho Claude khi bắt đầu dự án mới cùng loại (POS, quản lý bán hàng, SaaS nhỏ cho cửa hàng). Có skill đi kèm: `fnb-pos-architecture` (thư mục skills của Claude Code) tóm tắt cùng nội dung để Claude tự nạp.

---

## A. Phân tích kiến trúc

### A1. Bức tranh tổng thể

```
Khách / nhân viên
  Zalo bot ─┐
  App Flutter (Android, iOS, offline-first) ─┤
  Web admin (EJS) ─┤        ┌── Máy chủ Node/Express (một codebase) ──┐
  Trình quản lý Windows ────┤ │ /webhooks  /api (JWT)  /admin (cookie) │──▶ MySQL / MariaDB
                            │ │ /download  /cai-dat  /api/ngrok/claim  │
  Công cụ cấp phép ─────────┘ └─────────────────────────────────────────┘
Phân phối: trang /download (APK, IPA, EXE) · TestFlight (GitHub Actions) · Hostinger Node.js
Windows: bộ cài Inno Setup = MariaDB + Node + web + ngrok + trình quản lý (giấy phép theo máy, OTA)
```

Một lõi nghiệp vụ (models và services) phục vụ ba mặt: REST cho app, trang admin, bot chat. Quy tắc tiền, kho, thuế nằm ở service nên không lệch giữa các mặt.

### A2. Các lớp và quyết định then chốt

| Lớp | Quyết định | Lý do | Đánh đổi |
|---|---|---|---|
| Web admin | EJS + Tailwind CDN + JS thuần, form POST → redirect → flash | ít bề mặt tấn công, deploy đơn giản, không cần build front-end | không có tương tác phong phú như SPA |
| Backend | Express 5, MVC mỏng, services dày, `withTransaction` cho tiền/kho | dễ test, ít phụ thuộc | tự viết nhiều thứ (rate limit, session) |
| Dữ liệu | MySQL, schema thuần SQL, nâng cấp idempotent lúc boot | hợp shared hosting | không có công cụ migration |
| Cấu hình | `app_settings` (key/value) + override nạp lại mỗi 60 s | chủ quán đổi trong giao diện, không redeploy | cần chú ý quyền ghi và bí mật |
| Ghi quan trọng | `Idempotency-Key` lưu 24 h trong DB | nền tảng của offline, tránh trùng đơn | thêm một bảng và một middleware |
| App | Flutter, Riverpod, go_router, feature-first | một codebase cho Android và iOS | iOS cần macOS để build (dùng CI) |
| Offline | snapshot đọc + outbox ghi, id outbox là Idempotency-Key | quán mất mạng vẫn bán | mỗi loại ghi mới cần handler phát lại |
| In hóa đơn | vẽ ảnh rồi gửi raster ESC/POS | tiếng Việt có dấu không phụ thuộc code page | tốn băng thông hơn chữ thuần |
| Xác thực | bcrypt 12, JWT có `pws`, giới hạn tốc độ IP + tài khoản | đổi mật khẩu là vô hiệu hóa mọi phiên | cần dọn token cũ ở app |
| Quên mật khẩu | mã khôi phục XXXX-XXXX-XXXX-XXXX, lưu bcrypt, dùng xong đổi mã | không cần email, vẫn an toàn | chủ quán phải cất mã |
| Giấy phép | Ed25519, gắn mã máy, thử việc 14 ngày, chống lùi giờ | kiểm offline, khóa riêng không rời máy nhà cung cấp | chưa có thu hồi từ xa |
| Windows | Inno Setup gói MariaDB, Node, ngrok, trình quản lý Flutter | quán không cần kỹ thuật | bộ cài lớn (~90 MB) |
| OTA Windows | manifest + SHA-256, dựng URL từ server | an toàn trước manifest bị sửa | cần build lại bộ cài sau commit cuối |
| ngrok | môi giới trên server giữ khóa API của nhà cung cấp, cấp tên miền + token giới hạn `bind:<domain>` | khóa không lộ trong bản cài | cần gói ngrok trả phí |
| Đồng bộ cloud | máy quán là chủ, upsert theo khóa chính, watermark | đơn giản, idempotent | không đồng bộ xóa, một bên ghi một lúc |
| Thuế | sổ Excel xuất qua hàng đợi, mỗi loại sổ là một `kind` | không nghẽn request, nhẹ bộ nhớ | thêm loại mới phải sửa ENUM |
| Phân phối | `/download` với manifest, SHA-256, QR; gói deploy chứa APK/IPA/EXE | chủ quán tự phát hành | mỗi gói deploy phải mang file nhị phân |
| Deploy | `package-deploy` (git archive) → TUS → start-build Hostinger | lặp lại được, có kiểm tra | cần commit trước khi đóng gói |

### A3. Quy trình làm một tính năng (đã chạy tốt)
1. Service + test trước (mock model), lỗi dùng `AppError(status, code, thông báo tiếng Việt)`.
2. Route/controller; route công khai đặt trước kiểm tra đăng nhập, có giới hạn tốc độ.
3. View EJS, kiểm CSP.
4. Màn Flutter cùng nhãn tiếng Việt; ghi quan trọng qua outbox.
5. Chạy đủ test (Node với `--test-concurrency=2`, Flutter analyze + test).
6. Commit nhỏ, deploy, kiểm `/health` và trang liên quan.

### A4. Bài học và bẫy (đừng lặp lại)
- Commit đủ file **trước** khi đóng gói: gói deploy lấy từ `git archive HEAD`, từng bỏ sót `views/login.ejs`.
- Bộ cài Windows chứa bản sao mã server tại thời điểm build: build lại sau commit cuối.
- Không nhúng khóa API của nhà cung cấp vào bản cài: ai cũng trích ra được. Dùng môi giới phía server.
- Tên miền ngrok thuộc về tài khoản tạo ra nó: authtoken tài khoản khác không dùng được.
- Hostinger: `replace-environment-variables` xóa sạch biến (không đọc lại được); dùng `127.0.0.1` thay vì `localhost`; mỗi gói deploy thay toàn bộ file.
- `.env` local trỏ nhầm DB thật là nguy hiểm: các bước boot ghi vào dữ liệu thật.
- Tạo file bằng heredoc dài trên Git Bash hay lỗi: dùng công cụ ghi file hoặc script Python.
- Flutter trên Windows: chạy qua junction không có dấu cách, tắt `flutter_tester` trước khi test.
- bcrypt cắt ở 72 byte: đồng bộ giới hạn độ dài mật khẩu giữa các form.
- Làm offline sớm: thêm sau rất tốn công vì mọi loại ghi đều phải có nhãn, handler và hiển thị tạm.

### A5. Việc chưa làm / nên cải thiện (đưa vào dự án sau từ đầu)
- Thu hồi giấy phép từ xa, danh sách thu hồi kiểm định kỳ.
- Giới hạn đoán mã khôi phục nên lưu DB (hiện trong bộ nhớ tiến trình).
- CI chạy test Node, giám sát `/health` bên ngoài, sao lưu ra ngoài máy chủ.
- Sao lưu thẳng lên Google Drive (cần OAuth Google).
- Tách bước boot (seed, ảnh, sao lưu) khỏi lúc khởi động web để chạy dev an toàn.

---

## B. Prompt mẫu cho dự án mới

Cách dùng: sao chép khối bên dưới vào cuộc trò chuyện mới, thay các chỗ trong `<...>`. Nếu skill `fnb-pos-architecture` đã có, Claude sẽ tự nạp; vẫn nên giữ nguyên các ràng buộc trong prompt.

```text
Bạn là kỹ sư trưởng của dự án "<TÊN DỰ ÁN>" cho <LOẠI CỬA HÀNG / NGÀNH>. Hãy dùng skill fnb-pos-architecture và
docs/phan-tich-kien-truc-va-prompt-du-an-moi.md của dự án CoCoffee làm khuôn mẫu, KHÔNG sao chép nguyên: hãy áp dụng mẫu
và nói rõ chỗ nào bạn đổi và vì sao.

MỤC TIÊU
<1-3 câu: ai dùng, giải quyết việc gì. Ví dụ: quản lý bán hàng cho quán trà sữa, nhiều chi nhánh, nhân viên dùng điện thoại>

NGƯỜI DÙNG VÀ VAI TRÒ
<vai trò: chủ quán, quản lý, thu ngân... và quyền của từng vai trò>

PHẠM VI MVP (làm trước)
- <tính năng 1>   - <tính năng 2>   - <tính năng 3>
NGOÀI PHẠM VI (chưa làm): <...>

RÀNG BUỘC KỸ THUẬT (giữ như CoCoffee trừ khi tôi nói khác)
- Backend: Node/Express 5, MVC mỏng, service dày, giao dịch cho tiền và kho; MySQL/MariaDB, schema SQL thuần.
- Web admin: EJS + JS thuần, form POST → redirect → flash, CSP nonce, CSRF.
- App: Flutter (Android + iOS), Riverpod, offline-first (snapshot đọc + outbox ghi + Idempotency-Key).
- Triển khai: <Hostinger Node.js / VPS / bộ cài Windows kèm MariaDB>; deploy bằng gói git archive.
- Ngôn ngữ giao diện và thông báo lỗi: tiếng Việt. Tiền tệ và múi giờ: <VND, UTC+7>.
- Bảo mật: bcrypt cost 12, mật khẩu >= 10 ký tự, giới hạn tốc độ theo IP và tài khoản, không có tài khoản mặc định sống,
  quên mật khẩu bằng mã khôi phục, mọi bí mật nằm ngoài repo.

TÍCH HỢP
<Zalo bot / máy in nhiệt LAN-Bluetooth / VietQR / PayOn / thuế hộ kinh doanh / ngrok / giấy phép theo máy ...>

PHÂN PHỐI
<APK tự tải từ /download, TestFlight/App Store, bộ cài Windows, OTA...>

CÁCH LÀM VIỆC
1. Trước khi viết mã: đọc skill và mẫu, rồi trả lời tôi bằng (a) kiến trúc đề xuất ở mức 1 trang, (b) danh sách bảng DB chính,
   (c) kế hoạch 5-8 bước, (d) 3-5 rủi ro lớn nhất và câu hỏi cần tôi quyết. Chờ tôi xác nhận.
2. Mỗi bước: viết service và test trước, chạy test, commit nhỏ (thông điệp commit rõ ràng).
3. Không push, không deploy, không gửi tin ra ngoài khi tôi chưa nói rõ. Mọi khóa API, token, mật khẩu do tôi tự nhập;
   tuyệt đối không dán vào mã nguồn, log hay commit.
4. Báo cáo trung thực: nói rõ phần nào đã chạy và kiểm tra, phần nào chưa kiểm tra (ví dụ chưa thử trên máy thật).
5. Trả lời tôi bằng tiếng Việt đầy đủ (kể cả bảng và giải thích lỗi).

TIÊU CHÍ HOÀN THÀNH
- Test tự động đạt (Node và Flutter), phân tích tĩnh sạch.
- Chạy được từ DB rỗng: trang /cai-dat tạo chủ quán, không có tài khoản mặc định.
- Có hướng dẫn vận hành ngắn trong docs/ (cài đặt, sao lưu, phát hành, xử lý sự cố thường gặp).
- Có checklist phát hành và danh sách việc người dùng phải tự làm (biến môi trường, tài khoản bên thứ ba).
```

### B2. Bảng câu hỏi nên trả lời trước khi giao prompt
| Câu hỏi | Vì sao cần |
|---|---|
| Một quán hay nhiều quán (đa tenant)? | quyết định DB riêng từng quán hay chung |
| Máy chủ ở đâu (shared hosting, VPS, máy tại quán)? | ảnh hưởng bộ cài, sao lưu, ngrok |
| Có cần chạy khi mất mạng không? | nếu có, offline-first phải có từ ngày đầu |
| Thanh toán và in hóa đơn nào? | quyết định tích hợp và thiết bị |
| Có thu phí bản quyền theo máy không? | quyết định có cần giấy phép và môi giới |
| Phát hành lên store hay chỉ cài trực tiếp? | quyết định CI iOS, tài khoản developer, hồ sơ duyệt |
| Ai là người quản trị hệ thống và cất khóa? | khóa cấp phép, mã khôi phục, tài khoản bên thứ ba |
