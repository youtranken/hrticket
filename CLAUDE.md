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
2. **Postgres RLS là lưới an toàn cuối** — không BYPASSRLS. **`withActor` chạy `SET LOCAL ROLE app` mỗi tx** (role `app` non-superuser, tạo ở rls-and-extras.sql) — BẮT BUỘC, vì kết nối superuser/owner BỎ QUA RLS hoàn toàn. `tickets` có FORCE RLS. Ẩn menu FE = chỉ UX, không phải hàng rào.
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
- **FE:** kịch bản `[FE-DT]` nghiệm thu bằng **Playwright qua MCP** (plugin `playwright@claude-plugins-official`) — agent (phiên chính / subagent / teammate) **tự lái browser thật (headed, xem trực tiếp)** trên stack compose live (`:8080`): `browser_navigate` → `browser_snapshot` → `browser_click`/`browser_fill_form`/`browser_type` → assert theo acceptance criteria; `browser_take_screenshot` lưu chứng cứ; **Console 0 error** (`browser_console_messages`). Chuẩn bị 1 lần: `docker compose up -d --build` → `SEED_DEV_USERS=true pnpm --filter @hris/api db:seed` (4 user vai trò `@dev.local`). Mail xem ở **Mailpit UI** (`:8025`), KHÔNG MailHog.
  - **Luồng CRITICAL kèm e2e cam kết (cho CI):** login, tạo ticket từ mail, reply outbound, phân quyền/visibility → BẮT BUỘC xuất thêm 1 file `apps/web/e2e/*.e2e.ts` để CI chạy lại (`pnpm --filter @hris/web e2e`; xem trực quan `playwright test --headed`/`--ui`). FE không-critical chỉ cần MCP là đủ.
  - **CHỈ Playwright** (MCP để nghiệm thu + e2e suite cho CI) — KHÔNG dùng Chrome DevTools MCP hay công cụ browser khác. (BE vẫn integration test `*.it-spec.ts` như trên.)
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
- **RLS chỉ áp khi role không phải superuser/owner** — nếu test thấy member nhìn thấy mọi ticket, kiểm `SET LOCAL ROLE app` trong withActor + grants cho `app` trong rls-and-extras.sql.
- `file-type` (npm) là ESM-only → không require được trong CJS api; dùng `email-engine/magic-bytes.ts` (sniffer tự viết cho whitelist cố định).
- GreenMail canonicalise plus-alias (`a+b@x → a@x`) → test cross-post 2 mailbox phải dùng 2 địa chỉ KHÁC HẲN (không plus-alias).
- Dev IMAP = container **greenmail** trong compose (worker poll `:3143`, inject `:3025`); KHÔNG trỏ worker vào mailbox production.
- Outbox backoff đặt `next_attempt_at = now()` của **DB** (không phải `now` truyền vào hàm) → test re-claim phải đẩy thời gian bằng dữ liệu, không "tua" được qua tham số.
- Ảnh inline `cid:`: sanitize lúc ingest chỉ để **placeholder** `/api/files/{id}`, **ký URL ở read-time** (token TTL 15' sẽ chết nếu ký lúc ingest). `allowedStyles` whitelist typography — chặn `background/url()` để diệt `javascript:` trong CSS.
- Signed file URL cần **cả session + RLS**, không chỉ chữ ký (copy URL sang trình duyệt chưa login phải 401). Render HTML **in-DOM, KHÔNG iframe sandbox** (origin opaque → ảnh cid signed mất cookie → 401).
- `*.it-spec` dọn bảng theo thứ tự **con→cha** (FK: `inbox_messages`/`outbox`/`ticket_messages` → `tickets`). GreenMail `withStartupTimeout` cao (compose chạy song song làm Docker bind port chậm → suite skip nhầm `ready=false`).
- Cột thêm bằng custom-SQL / migration viết tay (vd `attachments.content_id`) mà cũng khai trong Drizzle schema → `db:generate` về sau dễ sinh migration trùng; nhớ resnapshot khi generate.
- Classify = substring `position(f_unaccent(lower(kw)) IN f_unaccent(lower(subject||body))) > 0`; **1 khớp → category đó, nhiều/không khớp → "Khác"**. Keyword seed phải đặc trưng (từ ngắn như "ot" nuốt nhầm).
- Auto-assign **khóa `assign_cursors` FOR UPDATE đầu tx** → mutex per-category cho CẢ round-robin LẪN least-load (chống TOCTOU/double-assign). Least-load đếm `Open/Assigned/In Progress` (không Pending/Closed); hòa → `max(assigned_at)` asc (null trước) → user_id. "Đang vắng" = `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN away_from AND away_to` tính LÚC ĐỌC (không job flip).
- Claim mặc định **pool-only** (atomic `WHERE assignee IS NULL AND status='open'`, 0 dòng → 409). Claim-over là chủ ý TƯỜNG MINH `{over:true}` (`WHERE assignee_id=<holder>`) — đừng auto-fallback, không thì kẻ thua race AC1 lại âm thầm cướp ticket.
- Gán thủ công BỎ QUA vắng mặt + target `disabled` → 422; re-classify "Khác" theo nhóm người nhận (1→set, n→`needsCategory` bắt chọn, 0→giữ) là bước SAU claim trong cùng flow (không phá atomic).
- **e2e tiêu đề mail dùng ASCII** — dấu tiếng Việt bị chuẩn hóa lại (NFC/NFD) qua MIME round-trip nên `getByText` trượt; classify bỏ dấu nên ASCII vẫn về đúng nhóm. Bảng ticket nhiều cột phải đặt `width` cho cột subject + `scroll={{x}}` nếu không cột flex co về 0 (Playwright coi là hidden).
- **State machine = pure fn ở `packages/shared/state-machine.ts`** (FE mirror qua `manualNextStates`), wrap ở `tickets/ticket.state-machine.ts` + `canActOnTicket`. `canTransition` trả `{ok}|{ok:false,code}`: `INVALID_TRANSITION`→409, `PENDING_REQUIRES_SNOOZE`→422 (validate ngày-quá-khứ ở service→422 TRƯỚC khi gọi pure fn để 422 thắng 409). `Open/Assigned→Closed` CHỈ hợp lệ kèm `reason` junk/duplicate (counter-metric); reopen edges (`closed→in_progress|open`) là system-driven nên `manualNextStates('closed')=[]` (reopen chỉ qua reply, không nút tay).
- **Reopen/wake nằm trong `appendMessageToTicket`** (gọi `handleReplyTransition` sau khi ghi message): auto-reply & người-lạ (không phải participant active) KHÔNG kích; `pending`→wake (in_progress, xóa snooze, reset `last_opened_at`); `closed`→reopen (assignee active+còn trong nhóm→in_progress giữ assignee+notify; else→`open` pool+assignee null+notify cả nhóm), `reopen_count+1`. Thứ tự guard: locked→notice(dedup 24h qua `reopen_notice_log`, im nếu spam)→junk/spam→reopen. "Reopened" = cờ suy ra từ `reopen_count>0` (không cột riêng).
- **Overdue/snooze tính LÚC ĐỌC bằng SQL `now()`** (test đẩy thời gian bằng cách backdate `last_opened_at`/`snooze_until`, KHÔNG tua clock): loại `resolved/closed`, snoozed-tương-lai miễn; Pending QUÁ hẹn tính mốc từ `snooze_until`. Ngưỡng đọc `reminder_config.overdue_days` per project (COALESCE 3). API trả sẵn `isOverdue/overdueDays/snoozeDue/overdueTotal` — FE không tự tính.
- **FE confirm dùng `modal` từ `App.useApp()`, KHÔNG `Modal.confirm` static** — static method không render dưới App provider (React 19), click ra "im lặng" (0 console, không dialog). `<Modal>` component vẫn ok. Pending modal dùng `<Input type="date">` (tránh dayjs/AntD DatePicker). Reply&Close checkbox chỉ hiện khi `canTransition(status,'closed').ok` (in_progress/resolved).

## Vai trò tài liệu (một sự thật, một nhà)
- `architecture.md` = **tại sao** (quyết định + Post-Review Amendments A–E).
- `CONVENTIONS.md` = **luật đầy đủ** (naming / structure / format).
- `_bmad-output/planning-artifacts/epics/` = **làm cái gì** (59 story, scope [DB/BE/FE] + test).
- File này = **nhắc ngắn + link**.

> Bồi đắp cuối mỗi epic (không distill một cục cuối). Giữ ≤200 dòng.
