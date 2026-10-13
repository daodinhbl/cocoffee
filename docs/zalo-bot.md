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

**Bot Client chỉ cần làm một việc:** gửi lần lượt từng `replies[i].text` vào `chat.groupId` (nếu có), nếu không thì gửi vào chat riêng với `chat.senderId`. `replies` rỗng nghĩa là không trả lời. Trong group, bot bỏ qua tin trò chuyện bình thường.

| `action` | Khi nào |
|---|---|
| `draft` | Tin nhắn có món: đã tạo hoặc cập nhật đơn nháp. Nhắn lại món để thay đơn, nhắn `thêm ...` để bổ sung. |
| `confirmed` | `ok` / `oke`: đã chốt đơn, `replies` chứa bill. |
| `cancelled` | `huy`: đã hủy đơn nháp. |
| `expired` | Đơn nháp quá `ZALO_DRAFT_TTL_MINUTES` phút: đã hủy, khách cần đặt lại. |
| `menu` | `menu`: trả về thực đơn. |
| `help` | Chat 1-1 nhưng không nhận ra món. |
| `ignored` | Tin trò chuyện trong group, hoặc `ok` khi người đó không có đơn nháp. |
| `error` | Hết hàng hoặc hệ thống bận. `replies` có câu giải thích cho khách. |

Mã lỗi HTTP: `401` sai hoặc thiếu Bearer, `400` thiếu `senderId`/`message`, `503` server chưa đặt `BOT_WEBHOOK_SECRET`, `429` gửi quá 120 tin/phút, `500` lỗi xử lý (`replies` rỗng, bot có thể thử lại với **cùng** `messageId`).

`GET /api/zalo/webhook` trả về `{"ok":true,"mode":"bot"}`, dùng để bot kiểm tra kết nối.

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
  for (const r of replies) await zalo.sendText(chat.groupId || chat.senderId, r.text, { isGroup: Boolean(chat.groupId) });
});
```
