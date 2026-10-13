# CoCoffee F&B — POS & Management backend

Node.js (Express 5, MVC) · MySQL · Zalo OA chatbot ordering · REST-ready for the Flutter tablet POS.
UI/UX spec: [docs/UI-UX-SPEC.md](docs/UI-UX-SPEC.md) · tokens: [docs/design-tokens.json](docs/design-tokens.json)

## Structure

```
app.js                      Passenger entry (JSON + rawBody for webhook signature, static, routes)
.htaccess                   Passenger block + HTTPS redirect (replace <PLACEHOLDERS>)
database/schema.sql         tables, FKs, indexes        database/seed.sql  demo menu/BOM/tables + admin/admin
src/config/                 env.js (dotenv) · db.js (pool + withTransaction)
src/routes/ controllers/ models/ middlewares/ utils/
src/services/               inventoryService (BOM/direct deduction, COGS) · orderService · receiptService
src/services/zalo/          zaloApiService · zaloAuthService (rotating tokens) · zaloSignature
src/webhooks/zalo/          controller · routes · order parser · conversation state machine
test/                       unit tests + DB integration test
```

## Local run

```bash
npm install
cp .env.example .env            # fill DB_*, JWT_SECRET
npm run db:init -- --seed       # DROPS & recreates tables on the DB in .env
npm start
npm test                        # unit tests; add RUN_INTEGRATION=1 + a *_test database for the DB suite
```

## Deploy on Hostinger shared hosting (cPanel · Setup Node.js App)

1. Import `database/schema.sql` then `database/seed.sql` in phpMyAdmin (database `cocoffee_fnb` selected).
2. Create the Node.js app: application root **outside** `public_html` (e.g. `cocoffee_app`), startup file `app.js`, domain `cocoffee.tasotek-giaiphapso.com`. Upload the project (without `node_modules`, `.env`), click **Run NPM Install**.
3. Set the variables from `.env.example` in the app's **Environment variables** (`DB_HOST=127.0.0.1`, never `localhost`).
4. Put `.htaccess` in the domain's document root with the values shown on the Node.js App screen.
5. Zalo developer console → webhook URL `https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook`; enable *user_send_text* (and *user_send_group_text* for GMF groups); turn **off** "Lọc cú pháp" (otherwise only messages starting with `#` arrive). If Zalo asks for domain verification, drop the provided file into `public/`.
6. Set `ZALO_BOOTSTRAP_REFRESH_TOKEN` once; afterwards the rotating tokens live in `zalo_tokens`.

## Security checklist

- **Default login is `admin` / `admin`.** Change it immediately: `POST /api/auth/change-password`.
- Keep `.env` out of git and out of `public_html`; use a long random `JWT_SECRET`.
- `ZALO_VERIFY_SIGNATURE` must stay `true` in production.
