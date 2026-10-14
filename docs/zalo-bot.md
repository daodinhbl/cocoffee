# Zalo chatbot

Có 2 cách nối chatbot đặt món với Zalo. **Nên dùng cách 1.**

## 1. Zalo Bot Platform (chính thức, khuyến nghị)

Bot tạo tại [bot.zaloplatforms.com](https://bot.zaloplatforms.com). Zalo gọi thẳng webhook trên Hostinger, server trả lời bằng API `sendMessage`, nên **không cần máy chạy bot riêng** và không có rủi ro khóa tài khoản cá nhân. Tài liệu API: [bot.zapps.me/docs](https://bot.zapps.me/docs).

1. Trên bot.zaloplatforms.com, mở bot của quán và sao chép **Bot Token**.
2. Trên hPanel (Node.js → Environment variables, thêm **từng biến**):
   - `ZALO_BOT_TOKEN` = token vừa sao chép;
   - `BOT_WEBHOOK_SECRET` = chuỗi bí mật 8–256 ký tự;
   - `PUBLIC_BASE_URL` đã có sẵn.
3. Deploy bản code mới. Có token thì app tự chạy ở chế độ `platform`.
4. Đăng ký webhook (chạy được trên máy của bạn, chỉ gọi API Zalo):
   ```bash
   ZALO_BOT_TOKEN=<token> BOT_WEBHOOK_SECRET=<secret> PUBLIC_BASE_URL=https://cocoffee.tasotek-giaiphapso.com node scripts/zalo-bot-setup.js
   ```
   Kết quả phải báo `Verification: OK webhook.ok`.
5. Mời bot vào nhóm của quán bằng link mời nhóm của bot. Chat nhóm đang ở giai đoạn **Beta** phía Zalo. Có thể nhắn kèm `@tên bot`, server tự bỏ phần nhắc tên trước khi đọc món.

Luồng xử lý: Zalo gửi `message.text.received` kèm header `X-Bot-Api-Secret-Token`. Server kiểm tra secret, lưu sự kiện (một `message_id` chỉ được xử lý một lần), trả 200 ngay, rồi xử lý đơn và gửi `sendMessage` vào `chat.id`. Đơn tạm, chốt đơn trong một transaction và gửi bill dùng chung lõi với cách 2 (xem phần "Đảm bảo khi khách chốt đơn" bên dưới). Nút "Gửi lại bill" trong admin hoạt động ở chế độ này.

## 2. Tài khoản Zalo cá nhân + Bot Client (dự phòng)

Hostinger (Passenger) không giữ được kết nối WebSocket hay trình duyệt ẩn để đăng nhập Zalo cá nhân. Vì vậy hệ thống tách làm hai phần:

| Thành phần | Chạy ở đâu | Việc |
|---|---|---|
| **Bot Client** | PC / VPS của quán (luôn bật) | Đăng nhập Zalo cá nhân, nghe tin nhắn (group và 1-1), **POST** từng tin lên webhook, rồi gửi lại vào đúng cuộc trò chuyện các `replies` mà server trả về. |
| **CoCoffee server** | Hostinger | Nhận tin, nhận diện món, tạo/sửa **đơn nháp**, chốt đơn trong **một MySQL transaction** (trừ kho theo BOM, chốt giá vốn) và trả nội dung trả lời/bill. |

> Lưu ý: tự động hóa tài khoản Zalo **cá nhân** bằng thư viện không chính thức không được Zalo hỗ trợ và có thể bị khóa tài khoản. Nên dùng một tài khoản riêng cho quán, không dùng tài khoản chính.

## Cấu hình server

| Biến | Giá trị |
|---|---|
| `BOT_WEBHOOK_SECRET` | Chuỗi bí mật dài, ví dụ tạo bằng `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Bot Client phải dùng đúng chuỗi này. |
| `ZALO_DRAFT_TTL_MINUTES` | `30`: đơn nháp tự hết hạn sau 30 phút. |
| `ZALO_MODE` | Không cần đặt. Mặc định là `bot`; `oa` chỉ để dùng lại Zalo OA cũ. |

Các biến của Zalo OA (`ZALO_APP_ID`, `ZALO_OA_SECRET_KEY`, `ZALO_APP_SECRET_KEY`, `ZALO_VERIFY_SIGNATURE`, `ZALO_BOOTSTRAP_REFRESH_TOKEN`) không còn dùng ở chế độ bot.

## Gọi webhook

```
POST https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook
Authorization: Bearer <BOT_WEBHOOK_SECRET>
Content-Type: application/json
```

### Payload Bot Client gửi lên

```json
{
  "groupId": "6612345678901234567",
  "senderId": "1987654321098765432",
  "senderName": "Lan",
  "message": "2 cà phê sữa, 1 bạc xỉu",
  "messageId": "7700112233445566"
}
```

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `senderId` | có | ID người gửi trên Zalo. |
| `message` | có | Nội dung tin nhắn dạng text, tối đa 2000 ký tự. |
| `groupId` | không | ID nhóm. Để `null` hoặc bỏ trống nếu là chat 1-1. |
| `messageId` | nên có | ID tin nhắn. Gửi lại cùng `messageId` thì server bỏ qua (`duplicate: true`), nên **không bao giờ tạo hay chốt đơn hai lần** khi bot gửi lại. |
| `senderName` | không | Chỉ lưu để tra cứu. |

### Response server trả về (HTTP 200)

```json
{
  "ok": true,
  "action": "draft",
  "chat": { "groupId": "6612345678901234567", "senderId": "1987654321098765432" },
  "replies": [
    { "type": "text", "text": "🧾 ĐƠN TẠM (chưa xác nhận)\n• 2 x Cà phê sữa đá — 50.000đ\n• 1 x Bạc xỉu — 29.000đ\nTỔNG: 79.000đ\n👉 Nhắn \"ok\" để xác nhận, \"huy\" để hủy. ..." }
  ]
}
```

Khi khách nhắn `ok` / `oke`:

```json
{
  "ok": true,
  "action": "confirmed",
  "chat": { "groupId": "6612345678901234567", "senderId": "1987654321098765432" },
  "replies": [
    { "type": "text", "text": "☕ CÒ COFFEE\nHÓA ĐƠN CF261013-00042\nThời gian: 13/10/2026 21:45\n────────────────\n• 2 x Cà phê sữa đá — 50.000đ\n• 1 x Bạc xỉu — 29.000đ\n────────────────\nTỔNG CỘNG: 79.000đ\nTrạng thái: Chưa thanh toán\nCảm ơn quý khách!" }
  ]
}
```

**Bot Client chỉ cần làm một việc:** gửi lần lượt từng phần tử của `replies` vào `chat.groupId` (nếu có), nếu không thì gửi vào chat riêng với `chat.senderId`. `replies` rỗng nghĩa là không trả lời. Trong group, bot bỏ qua tin trò chuyện bình thường.

Có hai loại phần tử:

| `type` | Trường | Gửi thế nào |
|---|---|---|
| `text` | `text` | Gửi tin nhắn văn bản. |
| `image` | `base64` (PNG), `mime`, `caption`, `url` | Ghi `base64` ra file tạm rồi gửi kèm ảnh (ví dụ ảnh VietQR của "check nợ"). `url` là link công khai có chữ ký, hết hạn sau 7 ngày (`/api/zalo/qr/<token>.png`), chỉ có khi đã đặt `PUBLIC_BASE_URL`. |

Với Zalo Bot Platform, server tự gửi ảnh bằng `sendPhoto` với link công khai đó, nên cần `PUBLIC_BASE_URL`.

| `action` | Khi nào |
|---|---|
| `draft` | Tin nhắn có món: đã tạo hoặc cập nhật đơn nháp. Nhắn lại món để thay đơn, nhắn `thêm ...` để bổ sung. Tùy chọn `ít/nhiều/không đường`, `ít/nhiều/không đá`, `đá riêng`, `size S/M/L` (hoặc `ly lớn/nhỏ`) được ghi vào ghi chú của dòng món. |
| `debt` | `check nợ`, `xem công nợ`, `mình còn nợ bao nhiêu`...: chỉ trả lời trong chat riêng, cho khách đã liên kết Zalo; kèm ảnh VietQR khi quán đã nhập tài khoản. |
| `faq` | Hỏi địa chỉ, wifi, giờ mở cửa, số tài khoản (không có món nào trong tin). Trong nhóm chỉ trả lời khi bot được @nhắc tên. Nội dung sửa ở **Admin → Zalo → Trả lời tự động & chuyển khoản**. |
| `confirmed` | `ok` / `oke` / `chốt đơn` / `đúng rồi`...: đã chốt đơn. `replies` gồm ảnh hóa đơn PNG 80mm (`type: image`; bill chữ nếu không vẽ được ảnh), rồi, khi quán đã nhập tài khoản ngân hàng, tin chữ số tài khoản + số tiền + nội dung chuyển khoản và ảnh VietQR đúng số tiền của đơn. |
| `cancelled` | `huy`: đã hủy đơn nháp. |
| `expired` | Đơn nháp quá `ZALO_DRAFT_TTL_MINUTES` phút: đã hủy, khách cần đặt lại. |
| `menu` | `menu`: trả về thực đơn. |
| `help` | Chat 1-1 nhưng không nhận ra món. |
| `ignored` | Tin trò chuyện trong group, hoặc `ok` khi người đó không có đơn nháp. |
| `error` | Hết hàng hoặc hệ thống bận. `replies` có câu giải thích cho khách. |

Mã lỗi HTTP: `401` sai hoặc thiếu Bearer, `400` thiếu `senderId`/`message`, `503` server chưa đặt `BOT_WEBHOOK_SECRET`, `429` gửi quá 120 tin/phút, `500` lỗi xử lý (`replies` rỗng, bot có thể thử lại với **cùng** `messageId`).

`GET /api/zalo/webhook` trả về `{"ok":true,"mode":"bot"}`, dùng để bot kiểm tra kết nối.

## Sau khi chốt đơn: hóa đơn PNG, số tài khoản, mã QR

Khách nhắn `ok` thì server (`services/zalo/billDelivery.js`) gửi theo thứ tự:

1. **Ảnh hóa đơn PNG khổ 80mm** (576px, vẽ bằng `pureimage` + font DejaVu, chạy được trên Hostinger). Không vẽ được hoặc Zalo từ chối ảnh thì gửi bill chữ thay thế.
2. Nếu đơn chưa thanh toán và Admin → Zalo → "Trả lời tự động & chuyển khoản" đã có tài khoản: tin chữ gồm ngân hàng, số tài khoản, tên chủ tài khoản, số tiền, nội dung chuyển khoản (mã đơn).
3. **Mã VietQR** của tài khoản đó, đúng số tiền của đơn.

Mỗi hóa đơn còn được lưu một bản tại `public/uploads/receipts/<khách hàng>/<yyyy>/<mm>/<dd>/` (`KH<mã>-<tên>`, `zalo-<id>` hoặc `khach-le`); mỗi lần deploy thư mục này bị thay.

Ảnh gửi bằng đường dẫn công khai có chữ ký, hết hạn sau 7 ngày: `/api/zalo/receipt/<token>.png` và `/api/zalo/pay-qr/<token>.png` (cần `PUBLIC_BASE_URL`). Bot Client nhận ảnh trực tiếp (`base64`) trong `replies`.

**Nút "Gửi lại bill"** (Admin → đơn hàng, POS) gửi đúng bộ này (ảnh, số tài khoản, QR) và báo cho chủ quán đã gửi gì, hoặc vì sao chỉ gửi được bill chữ.

**Chủ quán bấm "Thu tiền"** thì khách nhận tin "✅ ĐÃ NHẬN THANH TOÁN" (đơn, số tiền, hình thức, giờ) kèm lại ảnh hóa đơn đã đóng dấu ĐÃ THANH TOÁN. Thu nợ ở trang khách hàng thì khách nhận số tiền đã thu, các đơn đã tất toán và công nợ còn lại. Chỉ gửi được khi Zalo ở chế độ Bot Platform (hoặc OA) và khách đã liên kết Zalo; việc gửi chỉ là xác nhận thêm, không bao giờ làm hỏng việc thu tiền.

## Webhook: tự kiểm tra khi khởi động

Zalo chỉ gọi webhook đã đăng ký bằng `setWebhook` với đúng địa chỉ **và** khóa bí mật. Đổi `BOT_WEBHOOK_SECRET`, token hoặc tên miền trong hPanel mà không đăng ký lại thì mọi tin đến bị trả 401: bot nhận không được nhưng vẫn gửi đi được (trả lời, "Gửi lại bill"). Khi khởi động ở chế độ Bot Platform, server so dấu vân tay (địa chỉ + khóa) với lần đăng ký trước và với `getWebhookInfo` của Zalo, rồi tự đăng ký lại nếu khác. Log Hostinger ghi: `Zalo webhook info: …`, `Zalo webhook: registering … (lý do)`, từng sự kiện `Zalo event … -> action`, và `Zalo webhook REFUSED` (tối đa 1 dòng/phút) khi Zalo gọi sai khóa.

## Đảm bảo khi khách "chốt đơn"

- Đơn nháp gắn với **(nhóm, người gửi)**. `ok` của thành viên khác trong nhóm không chốt đơn của người khác.
- Chốt đơn chạy trong **một transaction**:
  - khóa phiên chat (`SELECT ... FOR UPDATE`) rồi khóa đơn;
  - chuyển nháp sang hoàn tất;
  - trừ kho theo định mức, ghi giá vốn;
  - ghi sổ công nợ nếu khách đã có trong danh sách khách hàng;
  - xóa phiên.

  Thiếu nguyên liệu (`INSUFFICIENT_STOCK`) hay bất kỳ lỗi nào thì **rollback toàn bộ**: đơn vẫn là nháp, tồn kho không đổi, khách nhận câu báo hết hàng.
- Tin nhắn của cùng một người trong cùng một chat được xử lý **tuần tự**. Gõ "2 cà phê" rồi "ok" ngay lập tức vẫn đúng thứ tự.
- Bill chỉ được tạo **sau COMMIT**. Lỗi gửi bill không bao giờ hủy đơn đã bán.

## Thử nhanh bằng curl

```bash
curl -s https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook \
  -H "Authorization: Bearer $BOT_WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"groupId":"g-test","senderId":"u-test","message":"1 bạc xỉu","messageId":"t-1"}'
```

## Khung Bot Client (Node.js, thư viện tùy chọn)

```js
// Đặt ở PC/VPS. `zalo` là đối tượng của thư viện bạn chọn, đã đăng nhập: chỉ cần onMessage và sendText.
const WEBHOOK = 'https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook';
const SECRET = process.env.BOT_WEBHOOK_SECRET;

zalo.onMessage(async (msg) => {
  if (msg.isSelf || typeof msg.text !== 'string') return;          // bỏ qua tin của chính bot và tin không phải text
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: msg.groupId || null, senderId: msg.senderId, senderName: msg.senderName, message: msg.text, messageId: msg.id }),
  });
  if (!res.ok) return console.error('webhook', res.status);
  const { chat, replies } = await res.json();
  const to = chat.groupId || chat.senderId;
  for (const r of replies) {
    if (r.type === 'image') {                                       // ảnh VietQR của "check nợ"
      const file = require('path').join(require('os').tmpdir(), `qr-${Date.now()}.png`);
      require('fs').writeFileSync(file, Buffer.from(r.base64, 'base64'));
      await zalo.sendImage(to, file, r.caption, { isGroup: Boolean(chat.groupId) });
      require('fs').rmSync(file, { force: true });
    } else {
      await zalo.sendText(to, r.text, { isGroup: Boolean(chat.groupId) });
    }
  }
});
```

Với thư viện `zca-js` (bản 2.x, ESM), gửi ảnh từ file là `api.sendMessage({ msg: caption, attachments: [file] }, threadId, type)` và phải khai báo `imageMetadataGetter` khi tạo `new Zalo({...})` (xem README của thư viện). Thư viện không chính thức này có thể làm tài khoản bị khóa: chỉ trả lời khi khách nhắn, giới hạn tốc độ gửi (ví dụ 20 tin/phút, cách nhau ≥ 2 giây trong một chat), không nhắn hàng loạt và không mở Zalo Web của tài khoản đó ở nơi khác (một tài khoản chỉ chạy được một listener).
