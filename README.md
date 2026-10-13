# CoCoffee F&B — POS & Management

Node.js (Express 5, MVC) · MySQL · Zalo OA chatbot ordering · REST API for the Flutter tablet POS · EJS + Tailwind Web Admin.
UI/UX spec: [docs/UI-UX-SPEC.md](docs/UI-UX-SPEC.md) · tokens: [docs/design-tokens.json](docs/design-tokens.json)

## Structure

```
app.js                      entry: security headers, JSON + rawBody (Zalo signature), static, /admin, /api
database/schema.sql         tables, FKs, indexes            database/seed.sql  demo menu/BOM/tables + admin/admin
src/config/                 env.js · db.js (pool + withTransaction) · bootstrapDb.js (first-boot schema)
src/routes/ controllers/ models/ middlewares/ utils/
src/services/               inventoryService (BOM/direct deduction, COGS) · orderService · receiptService
src/services/zalo/          zaloApiService · zaloAuthService (rotating tokens) · zaloSignature
src/webhooks/zalo/          controller · routes · order parser · conversation state machine
src/controllers/admin/      one controller per Web Admin module (dashboard, tables, orders, menu, inventory, bom, reports, zalo, settings)
src/middlewares/adminAuth   cookie session (HttpOnly, SameSite=Strict, audience "admin-web") + CSRF + flash + forced password change
views/                      layout.ejs · login.ejs · partials/{header,sidebar,footer,mobile_nav,csrf} · pages/<module>.ejs
public/admin/admin.js       vanilla JS (sidebar, tabs, dialogs, filter, cost calculator) — no framework
test/                       parser/signature unit tests · admin pages + jsdom UI tests (faked data layer, no DB) · MySQL integration tests
```

## Web Admin (`/admin`)

Server-rendered EJS, Tailwind via CDN (theme configured inline), vanilla JS, Times New Roman. Responsive tiers:
phone (<768: bottom tab bar, card lists, bottom-sheet dialogs) · tablet (icon rail) · laptop · desktop (sidebar 240px).

**Sign-in:** `/admin/login` with an account whose role is `admin` (cashiers use the POS app). A password shorter than 10 characters
(including the seeded `admin` / `admin`) is accepted once and then every page redirects to *Cài đặt → Đổi mật khẩu* until it is replaced.

| Module | Path | What it does |
|---|---|---|
| Tổng quan | `/admin/dashboard` | today's revenue / COGS / gross profit vs yesterday, bills to collect, recent orders, low stock |
| Bàn | `/admin/tables` | add / edit / retire tables, see which have a live order |
| Đơn hàng | `/admin/orders` · `/orders/:id` | filter (status, channel, payment, date, code) + paging; take payment, cancel, resend Zalo bill |
| Thực đơn | `/admin/menu` | categories, prices, Zalo chat keywords, retail goods (1:1 stock link), on/off sale |
| Nguyên liệu | `/admin/inventory` · `/inventory/:id` | stock, minimum, moving-average cost, stock value, stocktake / waste, ledger |
| Công thức (BOM) | `/admin/bom-recipes` | drink recipes with live COGS and margin; "delete" only takes the dish off sale |
| Nhập kho | `/admin/receiving` | goods received -> quantity + weighted-average cost |
| Báo cáo | `/admin/reports` | any date range: by day, hour, channel, payment method, top products |
| Zalo OA | `/admin/zalo` | token state, webhook counters (24 h), pending drafts, failed bills (retry), recent events |
| Cài đặt | `/admin/settings` | change password, staff accounts (add / reset password / lock), read-only system config |

Every state change is a plain HTML form (POST → redirect → flash message); destructive ones ask for confirmation. All of it goes through the
same models/services as the POS REST API, so stock, COGS and payment rules cannot diverge between the two.

## Local run

```bash
npm install
cp .env.example .env            # fill DB_*; JWT_SECRET is optional
npm run db:init -- --seed       # DROPS & recreates tables on the DB in .env
npm run dev                     # nodemon, or: npm start
npm test                        # unit + admin/UI tests (no DB needed); add RUN_INTEGRATION=1 and a *_test database for the DB suite
```

## Deploy on Hostinger (Node.js app + MySQL)

1. Create the database for the site with **Setup website database** (name `cocoffee`; Hostinger prefixes it, e.g. `u123456789_cocoffee`). The platform generates the password and writes `DB_HOST/PORT/NAME/USER/PASSWORD` into the app's environment — nobody has to see or paste it.
2. Set `AUTO_BOOTSTRAP_DB=true`, `SEED_DEMO=true` and `BOOTSTRAP_ADMIN_PASSWORD=<strong password>` for the first boot (the last one replaces the factory `admin/admin`; delete it afterwards — if it is missing or shorter than 10 characters a random admin password is generated and printed once in the app log, so `admin/admin` is never live). Set these variables **before** "Setup website database": that call keeps existing variables and appends `DB_*`, whereas the API's replace call would wipe the unreadable `DB_PASSWORD`. The app builds the schema **only if the database holds no data** (zero tables, or a half-finished bootstrap: only our tables, all empty), so later redeploys never touch data. Turn `SEED_DEMO` off afterwards if you do not want demo data on a fresh database.
3. Upload the source (no `node_modules`, no `.env`) and run the Node.js build: Express, entry file `app.js`.
4. Zalo developer console → webhook URL `https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook`; enable *user_send_text* (and *user_send_group_text* for GMF groups); turn **off** "Lọc cú pháp". Set `ZALO_APP_ID`, `ZALO_OA_SECRET_KEY`, `ZALO_APP_SECRET_KEY`, `ZALO_BOOTSTRAP_REFRESH_TOKEN` in hPanel (edit single variables there; the API's replace call wipes the ones you leave out).

## Security checklist

- **Default login is `admin` / `admin`** (from `seed.sql`). The Web Admin forces a new password at first sign-in; for the POS API use `POST /api/auth/change-password`.
- Web Admin sessions are an HttpOnly, SameSite=Strict cookie (Secure when `NODE_ENV=production` or the request arrived over HTTPS); every form carries a per-session CSRF token. Only active `admin` accounts can sign in, and API bearer tokens are not accepted as admin sessions. Login is rate-limited to 20 tries / 15 min per IP. Changing or resetting a password ends every older session of that account.
- Keep `.env` out of git and out of `public_html`. `ZALO_VERIFY_SIGNATURE` must stay `true` in production.
- `JWT_SECRET` is derived from `DB_PASSWORD` when unset; set it explicitly to rotate tokens independently.
