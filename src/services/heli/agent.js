// Heli's loop: model -> tool call -> result -> model ... until it answers. Only admins get the database tool.
const openai = require('./openai');
const heliDb = require('./heliDb');
const { ALLOWED_TABLES } = require('./sqlGuard');
const { AppError } = require('../../utils/httpError');

const MAX_STEPS = 8;
const MAX_HISTORY = 20;
const MAX_TOOL_CHARS = 6000;
const MAX_MESSAGE_CHARS = 1000;
const MAX_USERS = 200;

const TOOLS = [{
  type: 'function',
  function: {
    name: 'mysql_query',
    description: `Chạy MỘT câu SELECT chỉ-đọc (hoặc SHOW TABLES / DESCRIBE <bảng>) trên CSDL của quán. Bảng được phép: ${ALLOWED_TABLES.join(', ')}. Tối đa 50 dòng.`,
    parameters: { type: 'object', properties: { sql: { type: 'string', description: 'Câu SQL chỉ-đọc' } }, required: ['sql'] },
  },
}];

const todayVn = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

function system(user) {
  const base = `Bạn tên là Heli, trợ lý giọng nói của quán cà phê (Tasotek FnB). Người dùng: ${user.full_name || user.username} (${user.role === 'admin' ? 'quản trị' : 'thu ngân'}). Hôm nay là ${todayVn()} (giờ Việt Nam). ` +
    'Trả lời bằng tiếng Việt, thân thiện, NGẮN GỌN (1-3 câu khi có thể vì câu trả lời được đọc to), không bảng, không markdown, không ký hiệu. Tiền đọc dạng "1 triệu 200 nghìn đồng".';
  return user.role === 'admin'
    ? `${base} Khi cần số liệu thật (đơn hàng, doanh thu, sản phẩm, tồn kho...) hãy dùng mysql_query; xem cấu trúc bằng DESCRIBE trước khi viết SELECT. Không bịa số liệu; nếu không truy vấn được thì nói rõ.`
    : `${base} Bạn không có quyền xem số liệu của quán; nếu được hỏi số liệu, nói nhẹ nhàng rằng chỉ quản trị viên xem được.`;
}

const histories = new Map();
const busy = new Set();

function trim(h) {
  while (h.length > MAX_HISTORY) {
    const next = h.findIndex((m, i) => i > 0 && m.role === 'user'); // cut at a user turn so tool_calls/tool pairs stay together
    if (next === -1) break;
    h.splice(0, next);
  }
}

/** The only place a tool call is executed. The role is checked here, whatever the model asked for. */
async function runTool(call, user) {
  if (call.function.name !== 'mysql_query') return 'Tool không tồn tại.';
  if (user.role !== 'admin') return 'Từ chối: chỉ quản trị viên (admin) được truy vấn CSDL.';
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { return 'Tham số không hợp lệ.'; }
  return String(await heliDb.readOnlyQuery(args.sql)).slice(0, MAX_TOOL_CHARS);
}

async function chat(user, text) {
  const message = String(text || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new AppError(400, 'EMPTY', 'Chưa có nội dung');
  if (busy.has(user.id)) throw new AppError(409, 'HELI_BUSY', 'Heli đang xử lý câu trước');
  busy.add(user.id);
  try {
    if (!histories.has(user.id) && histories.size >= MAX_USERS) histories.delete(histories.keys().next().value);
    const h = histories.get(user.id) || [];
    histories.set(user.id, h);
    h.push({ role: 'user', content: message });
    const tools = user.role === 'admin' ? TOOLS : undefined;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const msg = await openai.chat([{ role: 'system', content: system(user) }, ...h], tools);
      h.push(msg);
      if (!msg.tool_calls || msg.tool_calls.length === 0) { trim(h); return msg.content || ''; }
      for (const call of msg.tool_calls) h.push({ role: 'tool', tool_call_id: call.id, content: await runTool(call, user) });
    }
    trim(h);
    return 'Câu hỏi hơi phức tạp, bạn thử chia nhỏ giúp mình nhé.';
  } finally {
    busy.delete(user.id);
  }
}

const reset = (userId) => { histories.delete(userId); };

module.exports = { chat, reset, runTool, TOOLS };
