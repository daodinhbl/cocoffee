# CoCoffee F&B — POS & Management

Node.js (Express 5, MVC) · MySQL · Zalo OA chatbot ordering · REST API for the Flutter tablet POS · EJS + Tailwind Web Admin.
UI/UX spec: [docs/UI-UX-SPEC.md](docs/UI-UX-SPEC.md) · tokens: [docs/design-tokens.json](docs/design-tokens.json)

## Structure

```
app.js                      entry: security headers, JSON + rawBody (Zalo signature), static, /admin, /api
database/schema.sql         tables, FKs, indexes            database/seed.sql  demo menu/BOM/tables + admin/admin
src/config/                 env.js · db.js (pool + withTransaction) · bootstrapDb.js (first-boot schema)
src/routes/ controllers/ models/ middlewares/ utils/ data/
src/services/               inventoryService (BOM/direct deduction, COGS) · orderService · receiptService
src/services/zalo/          zaloApiService · zaloAuthService (rotating tokens) · zaloSignature
src/webhooks/zalo/          controller · routes · order parser · conversation state machine
views/                      layout.ejs · partials/{header,sidebar,footer,mobile_nav} · pages/{dashboard,bom_recipes}
public/admin/admin.js       vanilla JS (sidebar, tabs, dialogs, filter, cost calculator) — no framework
test/                       parser/signature unit tests · jsdom UI tests · MySQL integration tests
```

## Web Admin (`/admin`)

Server-rendered EJS, Tailwind via CDN (theme configured inline), vanilla JS, Times New Roman. Responsive tiers:
phone (<768: bottom tab bar, card lists, bottom-sheet dialogs) · tablet (icon rail) · laptop · desktop (sidebar 240px).
**The pages currently show SAMPLE data and are unauthenticated** — do not wire real data in before an admin login exists.

## Local run

```bash
npm install
cp .env.example .env            # fill DB_*; JWT_SECRET is optional
npm run db:init -- --seed       # DROPS & recreates tables on the DB in .env
npm run dev                     # nodemon, or: npm start
npm test                        # unit + UI tests; add RUN_INTEGRATION=1 and a *_test database for the DB suite
```

## Deploy on Hostinger (Node.js app + MySQL)

1. Create the database for the site with **Setup website database** (name `cocoffee`; Hostinger prefixes it, e.g. `u123456789_cocoffee`). The platform generates the password and writes `DB_HOST/PORT/NAME/USER/PASSWORD` into the app's environment — nobody has to see or paste it.
2. Set `AUTO_BOOTSTRAP_DB=true` and `SEED_DEMO=true` for the first boot. The app builds the schema **only if the database has zero tables**, so later redeploys never touch data. Turn `SEED_DEMO` off afterwards if you do not want demo data on a fresh database.
3. Upload the source (no `node_modules`, no `.env`) and run the Node.js build: Express, entry file `app.js`.
4. Zalo developer console → webhook URL `https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook`; enable *user_send_text* (and *user_send_group_text* for GMF groups); turn **off** "Lọc cú pháp". Set `ZALO_APP_ID`, `ZALO_OA_SECRET_KEY`, `ZALO_APP_SECRET_KEY`, `ZALO_BOOTSTRAP_REFRESH_TOKEN` in hPanel (edit single variables there; the API's replace call wipes the ones you leave out).

## Security checklist

- **Default login is `admin` / `admin`** (from `seed.sql`). Change it immediately: `POST /api/auth/change-password`.
- Keep `.env` out of git and out of `public_html`. `ZALO_VERIFY_SIGNATURE` must stay `true` in production.
- `JWT_SECRET` is derived from `DB_PASSWORD` when unset; set it explicitly to rotate tokens independently.
