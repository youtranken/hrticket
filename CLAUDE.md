# CLAUDE.md — HRIS / C&B Ticket Management

> Living doc cho AI dev agent. **Đọc đầu mỗi phiên.** Trần cứng ≤200 dòng — chỉ giữ "lệnh + bất biến + cạm bẫy"; chi tiết link sang `CONVENTIONS.md` và `../​_bmad-output/planning-artifacts/architecture.md`.

## Dự án (1 dòng)
Hệ thống ticket nội bộ HRIS/C&B: biến 2 mailbox Gmail thành ticket quản lý được. On-premise, 2 project (`hris`, `cnb`), 40 user. "Nhỏ về tải, khó về tính đúng đắn" (email + phân quyền 2 trục + audit).

## Stack đã PIN (không tự nâng/đổi)
Node 24 LTS · NestJS 11 · React 19 · Vite 8 · TypeScript 5.x · PostgreSQL 18.4 · **Drizzle ORM** · pnpm workspaces · Ant Design · TanStack Query + Zustand · React Router v7 · ECharts · react-i18next · pino · Docker Compose · nginx · GitHub Actions.
Mailbox **DEV/TEST**: `leminh@pmh.com.vn` (hris) + `leminh+cnb@pmh.com.vn` (cnb). **CẤM trỏ mailbox production.** Địa chỉ là config (FR90), go-live đổi trên UI.

## Lệnh chuẩn
```
pnpm install                 # cài deps
pnpm dev                     # api :3000 + web :5173 (chạy ở app con)
docker compose up -d --build # postgres + api + worker + web(nginx) + mailpit(:8025)
                             # containers chạy BUILD PROD (NODE_ENV=production) NGAY TỪ ĐẦU —
                             # dev nhanh dùng `pnpm dev`. KHÔNG bao giờ chạy ts-node/watch trong image.
pnpm db:generate             # drizzle-kit generate → migration NNNN_slug.sql
pnpm db:migrate              # apply migration (forward-only)
pnpm db:seed                 # seed 2 project + categories + role_capabilities + SSA
pnpm lint                    # ESLint (ép naming + cấm import db thô)
pnpm test                    # unit (Jest BE / Vitest FE)
pnpm test:it                 # integration *.it-spec.ts (Testcontainers Postgres + GreenMail)
```

## LUẬT BẤT BIẾN (LOCKED — vi phạm là sai kiến trúc)
1. **Mọi truy cập DB qua `withActor(ctx, fn)`** (mở tx + `SET LOCAL` RLS var; từ chối nếu thiếu actor). ESLint **CẤM import `db` thô** ngoài `infra/db/with-actor.ts`. Worker = `withActor({kind:'system'})`. Repo nhận `tx`, service mở tx, 1 use-case = 1 tx.
2. **Postgres RLS là lưới an toàn cuối** — không BYPASSRLS. Ẩn menu FE = chỉ UX, không phải hàng rào.
3. **Zod ở `packages/shared` là nguồn type DUY NHẤT** (derive từ Drizzle qua drizzle-zod). **CẤM class-validator.** `.parse()` tại ranh giới controller.
4. **Email:** inbound **effectively-once** (`inbox_messages` UNIQUE `(message_id, mailbox)` — composite, KHÔNG global; commit IMAP cursor SAU persist). outbound **at-least-once** qua **outbox** (`pending→processing→done→failed`; đóng tx TRƯỚC khi gọi SMTP; re-claim theo `locked_at`). Outbox enqueue ở `infra/queue/`.
   Ngoại lệ: **OTP / reset / test-send / cảnh báo worker = SMTP trực tiếp** qua `infra/mail` (KHÔNG qua outbox).
5. **Pipeline ingest thứ tự BẤT BIẾN:** `dedupe → blocklist → mail-bomb → junk-rules → intake`. `intake` orchestrator gọi routing **đồng bộ trong tx** (không outbox-event). Module lá KHÔNG import nhau ngang hàng; `notifications` là sink được phép gọi từ mọi module.
6. **State machine = pure function** `canTransition(from,to,ctx)` ở `tickets/ticket.state-machine.ts` (không chạm DB). CẤM rải `if(status===…)`.
7. **Error catalog** `packages/shared/errors.ts` (enum UPPER_SNAKE, domain-prefix). `message` từ i18n key. Code không trong catalog = không tồn tại.
8. **Audit ghi TRONG tx ở tầng service** (worker + HTTP chung 1 đường). Audit append-only (REVOKE UPDATE/DELETE). Interceptor HTTP chỉ bắt request metadata.
9. **Attachment:** ghi file (UUID path) TRƯỚC commit; row `attachments.status pending→stored`; repair job dọn lệch. File qua app-layer (signed URL HMAC+TTL) — CẤM nginx serve tĩnh thư mục attachments.
10. **Ngày giờ = ISO 8601 UTC** ở BE; FE đổi giờ VN khi hiển thị; báo cáo/scheduler group theo `Asia/Ho_Chi_Minh`.
11. **Migration forward-only**, `NNNN_slug.sql` (4 số, không timestamp), **CẤM sửa migration đã merge**.
12. **Code / comment / commit / i18n-key = tiếng Anh.** Tiếng Việt CHỈ sống trong `vi.json` + dữ liệu DB.
13. **KHÔNG log** mật khẩu / OTP / token / nội dung lương / file nhạy cảm (pino redact).

## Test (story đóng khi test XANH)
- **BE:** integration `*.it-spec.ts` (Testcontainers Postgres 18.4 + GreenMail cho mail), đặt tên `IT-<DOMAIN>-NNN` (vd `IT-MAIL-001`). 4 vùng test KỸ: outbox, state machine, atomic assign/claim, idempotency mail.
- **FE:** kịch bản `[FE-DT]` = **Playwright** (`apps/web/e2e/*.e2e.ts`, config riêng) chạy thật trên browser với stack compose live (`:8080`), assert + screenshot, **Console 0 error**. Lệnh: bật `docker compose up -d --build` → `SEED_DEV_USERS=true pnpm --filter @hris/api db:seed` (tạo 4 user vai trò `@dev.local`) → `pnpm --filter @hris/web e2e`. Browser cài 1 lần: `pnpm --filter @hris/web exec playwright install chromium`. Mail xem ở **Mailpit UI** (`:8025`), KHÔNG MailHog.
- Đừng TDD full; code + test cùng story.

## Cạm bẫy đã biết
- Dedup mail là `(message_id, mailbox)` — để global sẽ NUỐT mail cross-post (FR17).
- Reopen-vào-pool dùng status `Open` (không `In Progress`) — nếu không, claim SQL không nhận → ticket-ma.
- Junk thủ công GIỮ category gốc (không đẩy về "Khác") — nếu không, rò ticket lương sang nhóm khác.
- Reply vào ticket junk/spam/locked → append/log, KHÔNG reopen.
- UIDVALIDITY đổi → re-scan bằng Message-ID, đừng tin UID cũ.
- **Docker prod build (đã trả giá):** (a) PG18 mount volume tại `/var/lib/postgresql` KHÔNG phải `/data`; (b) `nest build` cần `tsconfig.build.json` (chỉ `src`, `rootDir:src`) nếu không ra `dist/src/main.js` thay vì `dist/main.js`; (c) compose ép `NODE_ENV=production` (thắng `.env` dev) — nếu không pino bật `pino-pretty` (devDep, không có trong prod deploy) → crash; (d) worker phải giữ 1 active handle (timer) mới không exit 0 + `restart:always` quay vòng.
- `unaccent()` là STABLE → KHÔNG dùng trong generated column; bọc `f_unaccent()` IMMUTABLE (form 2 tham số) cho FTS tsvector.
- Seed idempotent cần **conflict target THẬT** (vd unique `(project_id,name_en)`); `onConflictDoNothing()` trống chỉ bắt PK → re-seed nhân đôi data.
- `test:it` đặt `maxWorkers:1` — mỗi suite tự bật 1 Postgres/GreenMail container; chạy song song đói Docker → flake (connection reset).

## Vai trò tài liệu (một sự thật, một nhà)
- `architecture.md` = **tại sao** (quyết định + Post-Review Amendments A–E).
- `CONVENTIONS.md` = **luật đầy đủ** (naming / structure / format).
- `_bmad-output/planning-artifacts/epics/` = **làm cái gì** (59 story, scope [DB/BE/FE] + test).
- File này = **nhắc ngắn + link**.

> Bồi đắp cuối mỗi epic (không distill một cục cuối). Giữ ≤200 dòng.
