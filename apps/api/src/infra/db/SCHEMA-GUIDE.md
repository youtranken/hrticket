# Sơ đồ Database — giải thích từng bảng & quan hệ

> Nguồn gốc: `apps/api/src/infra/db/schema/*.ts` (Drizzle).
> **1 database Postgres duy nhất** (`hris`), **2 project** (`hris`, `cnb`) phân biệt
> bằng cột `project_id` + RLS — KHÔNG tách database.
> Ký hiệu: `(PK)` khóa chính · `→ bảng` khóa ngoại trỏ tới · `(uq)` ràng buộc duy nhất.

---

## BẢN ĐỒ QUAN HỆ TỔNG (đọc từ trên xuống)

```
projects  (chỉ 2 dòng: hris, cnb)
│
├── users ......................... nhân viên nội bộ đăng nhập & xử lý ticket
├── categories ................... nhóm/loại (cũng là nhóm quyền)
│     └── category_keywords ...... từ khóa để tự phân loại email vào category
│     └── user_group_membership .. ai thuộc category nào (quyền xem)
│     └── auto_assign_config ...... cách chia việc tự động cho category đó
│           └── auto_assign_members  danh sách người trong vòng chia việc
│
├── tags ......................... nhãn dán ticket (ưu tiên / tự động / thủ công)
│
└── tickets ...................... ★ TRÁI TIM: mỗi email vào = 1 ticket
      ├── ticket_messages ........ từng email/ghi chú trong hội thoại
      │     └── attachments ...... file đính kèm (file nằm trên ổ đĩa, DB chỉ giữ metadata)
      ├── participants ........... người tham gia (To/Cc) của ticket
      ├── drafts ................. nháp trả lời đang soạn (lưu server)
      ├── ticket_tags ............ nối ticket ↔ tags (nhiều-nhiều)
      └── ticket_link ............ nối 2 ticket (vd cùng 1 mail gửi 2 hòm thư)

users  cũng là cha của:  sessions, otp_codes, password_reset_tokens,
                          notifications, view_log
```

**Cách đọc nhanh:** `projects` là gốc → mọi thứ "thuộc về" 1 trong 2 project.
`tickets` là trung tâm vận hành → gần như mọi bảng nghiệp vụ đều trỏ về `tickets`.
`users` là trung tâm con người → đăng nhập, được giao việc, nhận thông báo.

---

# NHÓM 1 — Project & con người & phân loại  (`core.ts`)

```
┌─────────────────────────────────┐
│ projects                        │   2 dòng cố định: hris và cnb.
│  id              (PK)           │   Là "gốc" của toàn hệ thống — mọi dữ liệu
│  key   = hris | cnb   (uq)      │   nghiệp vụ đều gắn project_id về đây để
│  name                           │   biết thuộc dự án nào.
└─────────────────────────────────┘
   QUAN HỆ: là CHA của hầu hết mọi bảng (users, categories, tickets, tags,
            config email/nhắc hạn... đều có project_id → projects.id).
```

```
┌─────────────────────────────────┐
│ users                           │   Nhân viên nội bộ (≈40 người). Đăng nhập,
│  id              (PK)           │   được giao ticket, có vai trò & ngôn ngữ.
│  project_id  → projects (null)  │   Chỉ vô hiệu (disabled), KHÔNG xóa.
│  email           (uq)           │   project_id để trống = SSA toàn cục (thấy
│  role = ssa|admin|team_lead|member│  cả 2 project); có giá trị = gắn 1 project.
│  disabled, otp_enabled,         │
│  away_from / away_to, ...       │   QUAN HỆ: con của projects · là CHA của
└─────────────────────────────────┘            tickets(assignee), sessions, otp,
                                                notifications, view_log...
```

```
┌─────────────────────────────────┐
│ categories                      │   Loại yêu cầu (vd "Lương", "Bảo hiểm"). Đồng
│  id              (PK)           │   thời là NHÓM QUYỀN: ai thuộc category mới
│  project_id  → projects         │   được xem ticket của category đó.
│  name_vi, name_en               │   is_sensitive = nhóm nhạy cảm (lương) → có
│  is_sensitive                   │   chốt bảo vệ + ghi view_log khi xem.
│  is_system  (nhóm "Khác")       │
│  (project_id, name_en) (uq)     │   QUAN HỆ: con của projects · là CHA của
└─────────────────────────────────┘            tickets, category_keywords,
                                                user_group_membership, auto_assign_*
```

```
┌─────────────────────────────────┐
│ category_keywords               │   Danh sách từ khóa của 1 category. Khi email
│  id              (PK)           │   tới, hệ thống dò từ khóa trong tiêu đề/nội
│  category_id → categories       │   dung để tự xếp ticket vào đúng category.
│  keyword                        │   1 khớp → category đó; nhiều/không → "Khác".
│  (category_id, keyword) (uq)    │
└─────────────────────────────────┘   QUAN HỆ: con của categories.
```

```
┌─────────────────────────────────┐
│ user_group_membership           │   BẢNG NỐI nhiều-nhiều: 1 user thuộc nhiều
│  user_id     → users      (PK)  │   category, 1 category có nhiều user. Đây
│  category_id → categories (PK)  │   chính là cơ chế phân quyền xem ticket.
└─────────────────────────────────┘   QUAN HỆ: nối users ↔ categories.
```

```
┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│ auto_assign_config              │        │ auto_assign_members             │
│  id              (PK)           │ 1───<  │  config_id → auto_assign_config │
│  category_id → categories (uq)  │        │  user_id   → users        (PK)  │
│  strategy = round_robin|least_load│      │  position  (thứ tự xoay vòng)   │
└─────────────────────────────────┘        └─────────────────────────────────┘
  Mỗi category cấu hình chia việc tự động     Danh sách người nhận việc xoay vòng
  thế nào. QUAN HỆ: con của categories.       (round-robin). Con của config + users.
```

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ assign_cursors                  │   │ project_counters                │
│  category_id → categories (PK)  │   │  project_id → projects   (PK)   │
│  last_user_id → users           │   │  last_no                        │
└─────────────────────────────────┘   └─────────────────────────────────┘
  Con trỏ "người vừa được giao gần      Bộ đếm số ticket mỗi project để sinh
  nhất" để xoay vòng công bằng.         mã "#00001" tăng dần, không trùng.
```

```
┌─────────────────────────────────┐
│ role_capabilities               │   Ma trận VAI TRÒ → được làm gì (FR55). SSA
│  (role, capability)   (PK)      │   chỉnh lúc chạy. KHÔNG có khóa ngoại — "role"
│  allowed  (true/false)          │   là giá trị enum, không phải dòng bảng users.
└─────────────────────────────────┘
```

---

# NHÓM 2 — Ticket & hội thoại  (`tickets.ts` + `attachments.ts`)

```
┌──────────────────────────────────────┐
│ tickets                ★ TRUNG TÂM   │   Mỗi email khách gửi vào tạo 1 ticket.
│  id                          (PK)    │   Giữ TRẠNG THÁI vòng đời (open → assigned
│  project_id  → projects              │   → in_progress → pending → resolved →
│  category_id → categories   (null)   │   closed), người xử lý, hạn hoãn (snooze),
│  assignee_id → users        (null)   │   số lần mở lại, cờ rác/nhạy cảm...
│  junked_from_category_id → categories│   assignee_id = NULL nghĩa là đang ở "pool"
│  ticket_code  (vd #00001)            │   (chưa ai nhận).
│  status, assigned_at, snooze_until,  │
│  reopen_count, is_junk, ...          │   QUAN HỆ: thuộc 1 project + 1 category +
│  (project_id, ticket_code)   (uq)    │   1 assignee. Là CHA của: messages,
└──────────────────────────────────────┘   attachments, participants, drafts,
                                            ticket_tags, ticket_link, view_log, *_log.
```

```
┌──────────────────────────────────────┐
│ ticket_messages                      │   Từng EMAIL hoặc GHI CHÚ NỘI BỘ bên trong
│  id                          (PK)    │   1 ticket (cả chiều đến và đi). Giữ nội
│  ticket_id   → tickets               │   dung text + HTML (bản thô để audit và bản
│  direction = inbound | outbound      │   đã làm sạch để hiển thị) + các header
│  is_internal  (ghi chú nội bộ)       │   threading (message_id, in_reply_to...).
│  from_addr, to_addrs[], cc_addrs[],  │
│  body_text, body_html, body_html_safe│   QUAN HỆ: con của tickets · là CHA của
│  message_id, in_reply_to, ...        │   attachments (file gắn theo message).
└──────────────────────────────────────┘
```

```
┌──────────────────────────────────────┐
│ attachments                          │   File đính kèm. FILE THẬT nằm trên Ổ ĐĨA
│  id                          (PK)    │   (đường dẫn theo UUID: {project}/{năm}/
│  ticket_id   → tickets               │   {tháng}/{uuid}); bảng này chỉ lưu METADATA
│  message_id  → ticket_messages (null)│   (tên gốc, kích thước, mime, trạng thái).
│  file_name, mime_type, size          │   status: pending → stored (ghi file xong
│  storage_path  (đường dẫn UUID)      │   mới commit). content_id = ảnh inline cid.
│  content_id, status                  │
└──────────────────────────────────────┘   QUAN HỆ: con của tickets (+ message).
```

```
┌──────────────────────────────────────┐
│ participants                         │   Người tham gia hội thoại (To/Cc của
│  id                          (PK)    │   ticket). Dùng để biết ai được phép reply
│  ticket_id   → tickets               │   làm ticket "thức dậy", ai chờ duyệt...
│  email                               │
│  status = active|pending_approval|...│   QUAN HỆ: con của tickets.
│  (ticket_id, email)          (uq)    │
└──────────────────────────────────────┘
```

```
┌──────────────────────────────────────┐
│ drafts                               │   Nháp trả lời / ghi chú đang soạn, lưu ở
│  id                          (PK)    │   server (tự lưu, sống sót khi F5). Mỗi
│  ticket_id   → tickets               │   (ticket + user + loại) chỉ 1 nháp.
│  user_id     → users                 │
│  kind = reply | note                 │   QUAN HỆ: con của tickets + users.
│  body, recipients_json               │
│  (ticket_id, user_id, kind)  (uq)    │
└──────────────────────────────────────┘
```

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ tags                            │   │ ticket_tags  (BẢNG NỐI N-N)     │
│  id              (PK)           │   │  ticket_id → tickets      (PK)  │
│  project_id  → projects         │1─<│  tag_id    → tags         (PK)  │
│  name, kind = manual|auto|priority │ └─────────────────────────────────┘
│  (project_id, name)      (uq)   │     Nối ticket ↔ nhãn (nhiều-nhiều).
└──────────┬──────────────────────┘
           │1
           ▼
┌─────────────────────────────────┐   Nhãn dán ticket: thủ công, tự động, hoặc
│ tag_keywords                    │   ưu tiên. tag_keywords = từ khóa để TỰ gắn
│  id              (PK)           │   nhãn (vd thấy "khẩn" → gắn nhãn ưu tiên).
│  tag_id      → tags             │
│  (tag_id, keyword)       (uq)   │   QUAN HỆ: tags con của projects;
└─────────────────────────────────┘   tag_keywords con của tags.
```

```
┌──────────────────────────────────────┐
│ ticket_link                          │   Nối 2 ticket với nhau (vd cùng 1 email
│  id                          (PK)    │   gửi tới cả 2 hòm thư → 2 ticket "anh em").
│  ticket_a    → tickets               │
│  ticket_b    → tickets               │   QUAN HỆ: cả 2 cột đều trỏ về tickets
│  kind = cross_post                   │   (quan hệ tự thân nhiều-nhiều).
└──────────────────────────────────────┘
```

---

# NHÓM 3 — Email vào/ra & chống lạm dụng  (`email.ts`)

```
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ inbox_messages   (MAIL ĐẾN)          │   │ outbox   (MAIL ĐI)                   │
│  id                          (PK)    │   │  id                          (PK)    │
│  project_id → projects               │   │  project_id → projects               │
│  ticket_id  → tickets       (null)   │   │  ticket_id  → tickets       (null)   │
│  mailbox, message_id, raw            │   │  to/cc/bcc[], subject, body          │
│  status = received|processed|        │   │  status = pending|processing|        │
│           suppressed|blocked|failed  │   │           done|failed                │
│  (message_id, mailbox)       (uq)    │   │  idempotency_key             (uq)    │
└──────────────────────────────────────┘   │  attempts, locked_at, ...            │
  Mail thô nhận về. Khóa duy nhất là       └──────────────────────────────────────┘
  (message_id, mailbox) → cùng mail gửi      Hàng đợi gửi đi (gửi-ít-nhất-1-lần).
  2 hòm thư vẫn thành 2 ticket (không nuốt). Đóng tx trước khi gọi SMTP, thử lại nếu lỗi.
```

```
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
│ imap_cursor                 │  │ blocklist                   │  │ junk_rules                  │
│  id              (PK)       │  │  id              (PK)       │  │  id              (PK)       │
│  mailbox         (uq)       │  │  project_id → projects      │  │  project_id → projects      │
│  folder, last_uid,          │  │  created_by → users (null)  │  │  kind = keyword | sender    │
│  uidvalidity                │  │  email, reason              │  │  pattern                    │
└─────────────────────────────┘  │  (project_id, email) (uq)   │  └─────────────────────────────┘
  Vị trí poll IMAP tới đâu rồi   └─────────────────────────────┘    Luật tự xếp mail vào "rác"
  (để không đọc lại mail cũ).      Người gửi bị chặn hẳn.            theo từ khóa / người gửi.
```

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ mail_bomb_counters              │   │ email_connections   (1 dòng/proj)│
│  id              (PK)           │   │  project_id → projects     (PK)  │
│  project_id → projects          │   │  imap_host/port/user             │
│  sender, window_start, count    │   │  smtp_host/port/user             │
│  (project,sender,window) (uq)   │   │  password_encrypted (AES-GCM)    │
└─────────────────────────────────┘   │  status, last_checked_at         │
  Đếm số mail/giờ của 1 người gửi      └─────────────────────────────────┘
  để chặn "dội bom" (spam hàng loạt).    Cấu hình IMAP/SMTP từng project, chỉnh
                                         trên UI. CÓ dòng này thì THẮNG biến env.
```

```
┌─────────────────────────────────┐
│ email_templates                 │   Mẫu email song ngữ (VI/EN): tự động báo
│  id              (PK)           │   nhận, bản tin tổng hợp, nhắc hết hạn hoãn,
│  project_id → projects          │   báo mở lại ticket, báo ticket đã khóa.
│  key  (auto_ack, digest, ...)   │
│  subject_vi/en, body_vi/en      │   QUAN HỆ: con của projects.
│  (project_id, key)       (uq)   │
└─────────────────────────────────┘
```

---

# NHÓM 4 — Vận hành, thông báo, audit  (`ops.ts`)

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ notifications                   │   │ view_log                        │
│  id              (PK)           │   │  id              (PK)           │
│  actor_id    → users            │   │  actor_id     → users           │
│  type, payload (JSON)           │   │  ticket_id    → tickets  (null) │
│  read_at, created_at            │   │  attachment_id→ attach   (null) │
└─────────────────────────────────┘   │  action = ticket_view |         │
  Thông báo chuông trong app           │           file_download         │
  (giao việc, mở lại...). FE poll       └─────────────────────────────────┘
  delta 15s. read_at = đã đọc.            Nhật ký AI ĐÃ XEM ticket/file nhạy
  QUAN HỆ: con của users.                 cảm (lương). QUAN HỆ: con của users.
```

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ reminder_config  (1 dòng/proj)  │   │ project_settings (1 dòng/proj)  │
│  project_id → projects   (PK)   │   │  project_id → projects   (PK)   │
│  overdue_days  (ngưỡng quá hạn) │   │  allowed_extensions[]           │
│  digest_hour   (giờ gửi bản tin)│   │  attachment_cap_mb              │
│  digest_enabled, digest_max_n   │   │  autotag_*, mail_bomb_per_hour  │
└─────────────────────────────────┘   │  disk_alert_pct                 │
  Cấu hình nhắc hạn & bản tin tổng     └─────────────────────────────────┘
  hợp cho từng project.                  Cấu hình động: loại file cho phép,
                                         dung lượng, ngưỡng cảnh báo ổ đĩa...
```

```
┌─────────────────────────────────┐  Các bảng "log" để CHỐNG GỬI TRÙNG của bộ
│ worker_heartbeats               │  lịch (scheduler) + nhịp tim worker. Phần lớn
│  loop_name       (PK)           │  do hệ thống tự ghi, không gắn người dùng:
│  last_beat_at, status           │
└─────────────────────────────────┘  • digest_log ......... 1 bản tin / người / ngày
┌─────────────────────────────────┐  • snooze_reminder_log  1 nhắc / ticket / ngày
│ digest_log                      │  • reopen_notice_log .. ≤1 báo-khóa / 24h / người
│  id (PK) · recipient · date_vn  │  • mail_bomb_alert_log  1 cảnh báo / cửa sổ
│  (recipient, date_vn)    (uq)   │
└─────────────────────────────────┘  reopen_notice_log & snooze_reminder_log
   (3 bảng còn lại cấu trúc tương tự,   → con của tickets;
    xem nhanh ở bảng FK cuối file)       mail_bomb_alert_log → con của projects.
```

```
┌──────────────────────────────────────────────────────────────────┐
│ audit_log   ⚠ KHÔNG khai trong Drizzle — tạo bằng SQL tay        │
│  Bảng PHÂN MẢNH theo năm (audit_log_2026, audit_log_2027, ...)   │
│  CHỈ-THÊM (append-only): role `app` chỉ được INSERT/SELECT,      │
│  bị REVOKE UPDATE/DELETE. Ghi trong cùng transaction nghiệp vụ.  │
└──────────────────────────────────────────────────────────────────┘
   Nhật ký kiểm toán mọi hành động quan trọng — không sửa/xóa được.
```

---

# NHÓM 5 — Đăng nhập & bảo mật  (`auth.ts`)

```
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
│ sessions                    │  │ otp_codes                   │  │ password_reset_tokens       │
│  id              (PK)       │  │  id              (PK)       │  │  id              (PK)       │
│  user_id → users            │  │  user_id → users            │  │  user_id → users            │
│  expires_at                 │  │  code_hash, expires_at      │  │  token_hash, used_at        │
└─────────────────────────────┘  │  attempts                   │  └─────────────────────────────┘
  Phiên đăng nhập lưu ở Postgres  └─────────────────────────────┘    Token đặt lại mật khẩu, dùng
  (sống sót khi restart server).    Mã OTP đã băm, có hạn, giới hạn   1 lần, đã băm.
  QUAN HỆ: con của users.           số lần thử. Con của users.        Con của users.
```

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ login_attempts                  │   │ idempotency_keys                │
│  id              (PK)           │   │  key             (PK)           │
│  kind = ip | account            │   │  created_at                     │
│  subject (ip hoặc email)        │   └─────────────────────────────────┘
│  failed_count, locked_until     │     Chống bấm-gửi-trùng cho các thao
│  (kind, subject)         (uq)   │     tác HTTP nhạy cảm. KHÔNG có FK.
└─────────────────────────────────┘
  Chống dò mật khẩu: khóa dần theo IP / tài khoản. KHÔNG gắn users.id
  (vì cần chặn cả khi gõ sai email không tồn tại).
```

---

## Ghi nhớ về 2 project trong 1 DB

- Mọi bảng nghiệp vụ có `project_id` → **RLS** + header project đang chọn
  (`X-Project`) tự lọc đúng dữ liệu 1 project. `tickets` bật **FORCE RLS**.
- App kết nối bằng role **`app`** (không phải superuser) nên RLS có hiệu lực.
  Bạn vào `psql -U hris` là **superuser → BỎ QUA RLS**, thấy cả 2 project.
- `users.project_id` để trống = SSA toàn cục; có giá trị = nhân viên 1 project.
- File `SCHEMA-ERD.md` (cạnh file này) có thêm **bảng tra cứu toàn bộ khóa ngoại**
  nếu cần liệt kê nhanh child → parent.
