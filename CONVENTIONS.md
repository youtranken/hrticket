# CONVENTIONS.md — Luật code đầy đủ (HRIS Ticket)

> Nguồn quy ước cho người. CLAUDE.md là bản nhắc ngắn trỏ về đây. Khi mâu thuẫn: architecture.md > CONVENTIONS.md > thói quen cá nhân.

## 1. Naming

### Database (Postgres qua Drizzle)
- Bảng: `snake_case` **số nhiều** (`tickets`, `ticket_messages`, `category_groups`).
- Cột: `snake_case`. FK: `<entity>_id`. Index: `idx_<bảng>_<cột>`.
- **Mapping tường minh**: `ticketCode: text('ticket_code')` — camelCase ở TS, snake_case ở DB. **CẤM plugin auto-casing.** Type DB lấy qua `$inferSelect` / `$inferInsert`.
- PK nội bộ `id` (bigserial/uuid). `ticket_code` (`#00001`) là MÃ HIỂN THỊ riêng theo project.

### API (REST)
- Đường dẫn số nhiều: `/api/tickets`, param `:id`. JSON **camelCase**.
- HTTP status chuẩn: 200/201/400/401/403/404/409/422/500.

### Code (TypeScript)
- Class / Component: `PascalCase`. Hàm / biến: `camelCase`. Hằng: `UPPER_SNAKE`.
- File NestJS: `kebab.role.ts` (`tickets.service.ts`, `ticket.state-machine.ts`).
- File React: `PascalCase.tsx`. Hook: `useXxx.ts`.

### Ngôn ngữ
Code / comment / commit / i18n-key = **tiếng Anh**. Tiếng Việt CHỈ trong `vi.json` + dữ liệu DB (`name_vi`, `body_vi`…).

## 2. Cấu trúc thư mục
```
app/
├── packages/shared/src/    # Zod schemas, db-zod (derive từ Drizzle), types (z.infer), errors.ts, constants.ts, worklist-order.ts
├── apps/api/
│   ├── src/
│   │   ├── main.ts          # entry HTTP (.listen)
│   │   ├── worker.ts        # entry WORKER (createApplicationContext, KHÔNG listen)
│   │   ├── core.module.ts   # DI lõi dùng chung main + worker
│   │   ├── modules/<feature>/   # auth, email-engine, intake, tickets, routing, permissions,
│   │   │                        # attachments, notifications, reporting, audit, admin, health
│   │   ├── common/          # filters, decorators, guards, interceptors
│   │   └── infra/           # db (with-actor, schema, migrations), queue, mail, storage, config, logger
│   └── test/                # *.it-spec.ts (Testcontainers + GreenMail)
└── apps/web/src/            # features/, layout/, components/, lib/, i18n/
```
- Test **co-located** unit: `*.spec.ts` / `*.test.tsx`. Integration: `apps/api/test/*.it-spec.ts`, `describe('IT-<DOMAIN>-NNN: …')`.
- Type/contract chung → `packages/shared`. `infra/db/schema` chỉ xuất **row-type** nội bộ; domain/DTO ở shared.

## 3. Ranh giới (chống xói mòn)
- Phụ thuộc **một chiều**: orchestrator (`intake`) import module lá; **module lá KHÔNG import nhau ngang hàng**.
- Giao tiếp ngược: qua **outbox event** hoặc bảng — không gọi hàm trực tiếp ngang hàng.
- `infra/` KHÔNG import `modules/`. `state-machine.ts` thuần domain, không chạm `withActor`.
- `outbox.enqueue` ở `infra/queue/`. `notifications.emit` = sink (INSERT), gọi được từ mọi module.
- FE ↔ BE: chỉ REST + type chung `packages/shared`.

## 4. Format response
- 1 bản ghi → object thẳng. Danh sách → `{ items, total, page, pageSize }`.
- Lỗi → `{ code, message, details? }` + HTTP status đúng. `code` từ `errors.ts`, `message` từ i18n key.
- Ngày giờ → ISO 8601 UTC. Boolean `true/false`. Null dùng `null`.

## 5. Data access & security (ép bằng cấu trúc)
- 1 cửa ra DB: `withActor(ctx, fn)` — mở tx, `SET LOCAL app.actor_id/app.actor_role/app.project_id/app.groups`, từ chối nếu thiếu actor.
- Set RLS var ở middleware (sau auth), trong tx — KHÔNG ở guard. Connection pin trong tx.
- Worker = system actor tường minh. RLS policy nhận biết, KHÔNG tắt RLS.
- HTTP mutation nhạy cảm: header `Idempotency-Key` + bảng `idempotency_keys`.

## 6. Validation, State, Errors
- Zod nguồn type duy nhất (`type X = z.infer<typeof xSchema>`), schema ở `packages/shared`, `.parse()` ở controller. CẤM class-validator DTO.
- State machine: pure `canTransition(from, to, ctx)`; service gọi trước khi ghi.
- Error catalog `errors.ts` (enum UPPER_SNAKE, domain-prefix vd `TICKET_NOT_FOUND`). Code ngoài catalog = không tồn tại.

## 7. Migration
- Chỉ `drizzle-kit generate` → `NNNN_slug.sql` (4 số, KHÔNG timestamp). **Append-only, CẤM sửa migration đã merge.** Forward-only (expand/contract). Commit kèm `meta/_journal.json`.

## 8. FE
- Lỗi qua TanStack Query → AntD `message`/`notification`. Loading: `isLoading` + AntD `Skeleton`/`Spin`.
- Server-state key dạng `['tickets', filters]`, invalidate sau mutation.
- Sidebar render theo quyền từ `/me` (ẩn menu = UX). Short-poll interval ≥10s + `If-Modified-Since`/304.
- i18n: mọi chữ qua `t('key')`; ESLint `no-literal-strings` trong JSX. Test key-parity vi/en.

## 9. Badge / thuật ngữ (FE thống nhất — frontend-design dùng chung)
- Trạng thái màu: Open xám · Assigned xanh dương · In Progress xanh lá · Pending vàng · Resolved tím · Closed đen.
- Badge: 🛡 Nhạy cảm · 🔒 Khóa reopen · 🗑 Rác · 🔇 Spam thread · "Reopened" (nhãn).
- Thuật ngữ: **Inbox** = ticket trong quyền · **"Ticket của tôi"** = assigned to me · **"Nhóm của tôi"/"Pool nhóm"** = ticket nhóm tôi.
- Responsive: desktop-first ≥1280px; ticket detail đọc được trên mobile (1 breakpoint).

## 10. Enforcement (máy ép)
- ESLint/Prettier ép naming + cấm import `db` thô + `no-literal-strings`.
- Test key-parity `vi.json` ↔ `en.json` (thiếu = đỏ).
- CI (GitHub Actions): lint + test + test:it + db:migrate mỗi push.
- Mọi truy cập ticket/file qua `withActor` + permission; input qua Zod; ngày giờ UTC.
