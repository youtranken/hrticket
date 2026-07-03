# HRIS / C&B Ticket System — Tổng hợp giá trị cốt lõi & luồng hoạt động

> Tài liệu tổng quan cho người mới (dev/vận hành). Chi tiết luật đầy đủ xem `CLAUDE.md`,
> `CONVENTIONS.md`, `architecture.md`. ERD xem `docs/ERD.md`.

---

## 1. Dự án là gì (1 đoạn)

Hệ thống **ticket nội bộ cho phòng Nhân sự (HRIS) và Lương–Phúc lợi (C&B)**: biến **2 hộp thư
Gmail** (`hris`, `cnb`) thành một hệ thống ticket quản lý được — phân loại, giao việc, trả lời,
theo dõi vòng đời, audit. Chạy **on-premise**, ~**40 người dùng**, 2 project độc lập.

Đặc thù: **"nhỏ về tải, khó về tính đúng đắn"**. Lượng ticket không lớn, nhưng độ khó nằm ở:
email (idempotency, cross-post), **phân quyền 2 trục**, và **audit không thể chối bỏ**.

---

## 2. Những giá trị cốt lõi (tâm đắc nhất)

Đây là 6 quyết định kiến trúc làm nên "chất" của dự án. **#1 và #2 là tâm đắc nhất** — chúng
là thứ khiến hệ thống *đúng* chứ không chỉ *chạy*.

### ⭐ #1 — Postgres RLS là lưới an toàn CUỐI CÙNG (không chỉ tin app-layer)
- **Mọi** truy cập DB đi qua `withActor(ctx, fn)` → mở transaction + chạy `SET LOCAL ROLE app`
  (role non-superuser) + set các biến RLS của actor. ESLint **cấm import `db` thô** ngoài
  `with-actor.ts`.
- Vì sao tâm đắc: nếu một ngày ai đó **quên** một câu `if` kiểm quyền ở tầng service, **RLS ở
  DB vẫn chặn** — member không thể đọc ticket ngoài nhóm dù câu SQL có sai. Menu ẩn ở FE **chỉ
  là UX**, không phải hàng rào. Bảng `tickets` bật `FORCE ROW LEVEL SECURITY`.
- Điểm tinh tế: **"giữ việc dở"** — RLS cho ex-assignee thấy ticket mình từng giữ *chỉ khi
  `status <> 'closed'`*. Đóng ticket = mất quyền xem (need-to-know).

### ⭐ #2 — Mô hình phân quyền 2 trục: "AI XỬ LÝ" vs "AI ĐIỀU PHỐI"
Đây là phần **khó đúng nhất** của nghiệp vụ:
- **Member + Team Lead (trong nhóm)** = người **XỬ LÝ**: được `claim` (nhận) + `reply` (trả lời email).
- **Admin / SSA** = người **ĐIỀU PHỐI**: `assign` (giao việc), đổi trạng thái/đóng/khóa/junk/đổi
  nhóm — nhưng **KHÔNG BAO GIỜ claim, KHÔNG reply** (họ giám sát, không tự làm).
- **Claim-over có thứ bậc**: member chỉ "cướp" được ticket từ **member** cùng nhóm; không kéo
  được của TL/Admin. TL over được mọi người trong nhóm.
- 2 cổng quyền **khác nhau**: `canActOnTicket` (giám sát vòng đời — gồm Admin/SSA) ≠
  `canReplyTicket` (gửi email — **loại** Admin/SSA). Gọi nhầm cổng = admin reply lọt.

### #3 — Email: inbound "đúng-một-lần", outbound "ít-nhất-một-lần"
- **Inbound effectively-once**: `inbox_messages` UNIQUE `(message_id, mailbox)` — **composite,
  KHÔNG global** (nếu global sẽ nuốt mail cross-post giữa 2 project). Commit con trỏ IMAP *sau*
  khi persist.
- **Outbound at-least-once** qua **outbox pattern**: `pending → processing → done → failed`.
  Đóng transaction *trước* khi gọi SMTP; re-claim theo `locked_at`. Không mất mail, không double
  nhờ idempotency.
- Ngoại lệ gửi thẳng SMTP (không qua outbox): OTP / reset mật khẩu / test-send / cảnh báo worker.

### #4 — Một sự thật, một nhà (single source of truth)
- **Zod ở `packages/shared`** = nguồn type DUY NHẤT (derive từ Drizzle qua drizzle-zod).
  `.parse()` tại ranh giới controller. Cấm class-validator.
- **State machine = pure function** `canTransition(from, to, ctx)` — không chạm DB, không rải
  `if (status === …)` khắp nơi.
- **Worklist order = 1 spec** (`packages/shared/worklist-order.ts`) dùng cho cả SQL lẫn digest,
  có **test tương đương** (IT-LIST-001) đảm bảo 2 bản không lệch nhau.
- **Error catalog** (`packages/shared/errors.ts`): code không có trong catalog = không tồn tại.

### #5 — Audit không thể chối bỏ (append-only ở tầng DB)
- `audit_log` phân mảnh theo năm (`audit_log_2026…2031`), role `app` bị **REVOKE UPDATE/DELETE**
  → chỉ INSERT/SELECT. Không ai (kể cả app) sửa/xoá được log.
- Audit ghi **trong transaction ở tầng service** (worker + HTTP chung một đường). Interceptor
  HTTP chỉ bắt metadata request.

### #6 — Thời gian & tính toán tại read-time
- BE lưu **ISO 8601 UTC**; FE đổi giờ VN khi hiển thị; báo cáo group theo `Asia/Ho_Chi_Minh`.
- **Overdue/snooze tính lúc ĐỌC** bằng SQL `now()` — FE không tự tính, API trả sẵn
  `isOverdue/overdueDays/snoozeDue`. Một nguồn sự thật cho cả list lẫn digest.

---

## 3. Vai trò người dùng

| Vai trò | Phạm vi | Làm được gì |
|--------|---------|-------------|
| **member** | 1 project, các nhóm (category) mình thuộc | Nhận (claim) + trả lời ticket trong nhóm |
| **team_lead** | 1 project, nhóm mình phụ trách | Như member + claim-over cả nhóm |
| **admin** | 1 project (toàn bộ) | Điều phối: giao việc, đổi trạng thái, junk, cấu hình project |
| **ssa** | **cả 2 project** (super) | Điều phối xuyên project + cấu hình hệ thống, ma trận quyền |

> "Nhóm" = `category` (Payroll, Insurance, Leave…). Quan hệ member↔nhóm nằm ở
> `user_group_membership`.

---

## 4. Luồng hoạt động

### 4.1 Ingest — Email → Ticket (worker, tự động)
Thứ tự pipeline **BẤT BIẾN**:

```
IMAP poll (mỗi 60s — NFR3, POLL_INTERVAL_MS=60000)
   → dedupe            (message_id + mailbox; đã thấy → bỏ)
   → blocklist         (người gửi bị chặn → drop)
   → mail-bomb         (1 người gửi vượt ngưỡng → cảnh báo, chặn)
   → junk-rules        (khớp luật rác → đánh dấu junk, GIỮ category gốc)
   → intake            (tạo/nối ticket)
        ├─ classify    (so khớp keyword không dấu → 1 khớp = nhóm đó, nhiều/0 = "Khác")
        └─ routing      (đồng bộ trong tx): auto-assign HOẶC vào Pool
   → notify            (thông báo cho người liên quan)
```
- **Reply vào ticket cũ** (khớp `In-Reply-To`/`References`) → nối vào thread, có thể **wake**
  (pending→in_progress) hoặc **reopen** (closed→open/in_progress), `reopen_count += 1`.
- Reply vào ticket junk/spam/locked → chỉ append/log, **KHÔNG** reopen.
- **Auto-assign hiện đang TẮT** (`AUTO_ASSIGN_ENABLED=false`) → mọi ticket mới vào **Pool** để
  member/TL tự nhận. (Round-robin/least-load vẫn còn code, bật lại bằng env.)

### 4.2 Xử lý — vòng đời ticket (member/TL)
```
Pool ──claim──▶ My tickets ──reply──▶ (khách trả lời qua lại)
                    │                        │
                    ├── snooze ──▶ Pending ──(tới hạn / khách reply)──▶ wake
                    ├── resolve ──▶ Resolved
                    └── close ────▶ Closed ──(khách reply)──▶ reopen
```
- Trạng thái: `open → assigned → in_progress → pending → resolved → closed`.
- **Reply outbound** đi qua **outbox → SMTP** (at-least-once).
- Sắp xếp danh sách mặc định = **band order** (mới/reopen trên cùng → quá hạn đỏ → đang xử lý →
  chờ → đã giải quyết → đóng/rác chìm đáy).

### 4.3 Điều phối (admin/ssa)
- `assign` giao ticket cho TL/member; nếu ticket là "Khác" → có bước **re-classify** theo nhóm
  người nhận (1 nhóm→gán; nhiều→bắt chọn; 0→giữ) *sau* claim, không phá tính atomic.
- Đổi trạng thái / đóng / khóa reopen / đánh dấu junk / đổi nhóm — qua `canActOnTicket`.

### 4.4 Nền (scheduler tick mỗi 60s + worker)
- **Digest**: email tổng hợp theo giờ VN (`digest_hour`), dedup qua `digest_log`.
- **Nhắc quá hạn / snooze tới hạn**: `overdue_escalation_log`, `snooze_reminder_log`.
- **Outbox sender**: đẩy mail chờ, backoff theo `next_attempt_at`.
- **Attachment-repair**: dọn file lệch trạng thái (`pending` treo).
- **Worker heartbeat** (`worker_heartbeats`): nếu loop chết → cảnh báo `worker_alert`.
- **Disk monitor**: đĩa sắp đầy → thông báo `disk_low`.

### 4.5 Thông báo trong app (chuông)
- Bell **poll mỗi 15s**, conditional-GET (304 nếu không đổi → không re-render). Loại: được gán,
  bị nhận về, reopen, snooze tới hạn, mail-bomb, lỗi mail, worker/đĩa cảnh báo.

---

## 5. Đính kèm & bảo mật file
- Ghi file (path UUID) **trước** commit; row `attachments.status: pending → stored`; repair job
  dọn lệch.
- File **không** để nginx serve tĩnh — đi qua app-layer bằng **signed URL** (HMAC + TTL 15').
- Ảnh inline `cid:` → sanitize thành placeholder lúc ingest, **ký URL ở read-time**.
- Signed URL cần **cả session + RLS** (copy URL sang trình duyệt chưa login → 401).

---

## 6. Stack công nghệ (đã pin — không tự nâng)
Node 24 · **NestJS 11** · **React 19** + Vite · TypeScript · **PostgreSQL 18.4** + **Drizzle ORM**
· pnpm workspaces · Ant Design · TanStack Query + Zustand · React Router v7 · react-i18next · pino
· Docker Compose + nginx.

**Bảo mật**: mật khẩu **argon2id**; ký HMAC fail-closed; đăng nhập constant-time; disabled chặn ở
**tầng session** (không phải RLS).

---

## 7. Kiểm thử
- **BE**: integration `*.it-spec.ts` (Testcontainers Postgres 18.4 + GreenMail). 4 vùng test kỹ:
  outbox, state machine, atomic assign/claim, idempotency mail.
- **FE**: Playwright e2e (`apps/web/e2e/*.e2e.ts`) chạy trên stack docker thật. Harness cấu hình
  được qua env (`E2E_BASE_URL`, `E2E_SMTP_PORT`, `E2E_COMPOSE`) để chạy trên stack cô lập
  (`docker-compose.e2e.yml`, cổng riêng) mà không đụng prod/mail thật.

---

## 8. Triển khai (prod)
```
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```
- HTTPS `:8443`. Thứ tự: `migrate` (one-shot) → `api`/`worker` → `web` (nginx).
- **Cạm bẫy đã trả giá**: khi `api` được recreate, **IP container đổi** → nginx (`web`) cache IP
  cũ → **502**. ⇒ luôn **restart/recreate `web` SAU `api`**.
- Config email theo cơ chế **DB thắng env** (`email_connections` có row → dùng; không → fallback
  env) → đổi mailbox không cần restart.
</content>
</invoke>
