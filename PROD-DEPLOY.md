# Runbook đưa hệ thống lên Production (HRIS / C&B)

> On-premise, 2 project (`hris`, `cnb`), ~40 user. Stack chạy bằng Docker Compose
> (postgres + api + worker + web/nginx). Tài liệu này là **checklist go-live đầy đủ** —
> làm tuần tự từ trên xuống. Mọi lệnh chạy từ thư mục `E:\PMH\hr\app`.

---

## 0. Tổng quan kiến trúc khi lên prod

```
[Người dùng]──HTTPS──> [Reverse proxy / TLS]──> web (nginx, FE tĩnh) ──/api──> api :3000
                                                                          │
                                              worker (poll IMAP, gửi outbox)│
                                                                          ▼
                                                   postgres (1 DB: hris, RLS, role app)
                                                   attachments (bind mount, file đính kèm)
```

- **Bỏ** 3 service chỉ dùng cho dev/test: `mailpit`, `greenmail` (và mọi env trỏ tới chúng).
- Container chạy **prod build** sẵn (`NODE_ENV=production`). Mọi thay đổi code → `docker compose up -d --build <service>`.
- **Migration KHÔNG tự chạy** khi container khởi động (CMD chỉ `node dist/main.js`). Phải chạy `db:migrate` thủ công 1 lần ở mỗi lần deploy có migration mới.

---

## 1. Hạ tầng máy chủ

- [ ] Máy chủ on-prem: Docker Engine + Docker Compose v2, đủ RAM/disk (file đính kèm + DB nằm trên volume — tính dung lượng theo lượng mail/attachment).
- [ ] Tên miền nội bộ (vd `hris.pmh.local` / `hris.pmhung.vn`) trỏ về máy chủ.
- [ ] **TLS/HTTPS bắt buộc** (xem mục 6) — vì cookie phiên đặt `secure:true` ở prod, sẽ KHÔNG gửi qua HTTP thuần → không đăng nhập được nếu chạy http.
- [ ] NTP đồng bộ giờ máy chủ (scheduler/digest tính theo giờ VN).

---

## 2. Secrets & biến môi trường (HỢP ĐỒNG bắt buộc)

App **fail-fast lúc boot** nếu thiếu/sai (xem `config.schema.ts`). Các biến **BẮT BUỘC**:

| Biến | Ràng buộc | Ghi chú |
|---|---|---|
| `DATABASE_URL` | URL hợp lệ | `postgres://hris:<MẬT_KHẨU_MẠNH>@postgres:5432/hris` |
| `SESSION_SECRET` | ≥ 16 ký tự | ngẫu nhiên mạnh |
| `HMAC_SIGNING_KEY` | ≥ 16 | ký signed-URL file đính kèm |
| `ATTACHMENT_ENCRYPTION_KEY` | ≥ 16 | AES key |

Khuyến nghị đặt thêm:

| Biến | Mặc định | Prod nên đặt |
|---|---|---|
| `EMAIL_SECRET_KEY` | (fallback về `ATTACHMENT_ENCRYPTION_KEY`) | key riêng để mã hoá App Password email trong DB |
| `APP_BASE_URL` | `http://localhost:8080` | `https://hris.pmh.vn` — dùng dựng link trong mail reset/digest |
| `WEB_ORIGIN` | `http://localhost:5173` | `https://hris.pmh.vn` (CORS, cho phép cookie) |
| `NODE_ENV` | `development` | **`production`** (compose đã ép sẵn) |
| `ATTACHMENT_STORAGE_ROOT` | `./attachments` | `/data/attachments` (compose đã đặt) |

**Sinh secret mạnh** (mỗi cái 1 dòng riêng):
```bash
openssl rand -base64 32   # chạy 4 lần cho SESSION_SECRET, HMAC_SIGNING_KEY, ATTACHMENT_ENCRYPTION_KEY, EMAIL_SECRET_KEY
```

**Cách nạp secret (chọn 1):**
- Đơn giản: file `.env` cạnh `docker-compose.yml` (quyền `chmod 600`, KHÔNG commit git).
- An toàn hơn (Docker secrets): với mọi biến `FOO`, đặt `FOO_FILE=/run/secrets/foo` trỏ tới file → app tự đọc nội dung file thành `FOO` (`load-secrets.ts`).

⚠️ Hiện `.env` đang là giá trị dev (`change-me-...`, `hris:hris`). **Phải thay hết** trước go-live.

---

## 3. Mailbox thật (2 project)

> **CẤM trỏ mailbox production trong môi trường test.** Dev đang dùng GreenMail/Mailpit.

1. [ ] **Gỡ** service `mailpit` + `greenmail` khỏi compose prod.
2. [ ] **Gỡ** mọi env `IMAP_*`/`SMTP_*` trỏ greenmail/mailpit ở `worker` và `api`.
3. [ ] Cấu hình mailbox thật — **2 cách** (DB thắng env):
   - **Khuyến nghị:** đăng nhập SSA → **/admin/email-connection**, nhập IMAP/SMTP + App Password cho **từng project**. Lưu DB (mã hoá AES), đổi không cần restart, `connection-resolver` đọc lại mỗi cycle.
     - **Chỉ lấy mail mới từ go-live:** khi lưu kết nối lần đầu, hệ thống tự **mồi con
       trỏ poll** tới UID hiện tại của hộp thư → intake **chỉ tạo ticket từ thư đến SAU
       thời điểm đó**, KHÔNG nạp toàn bộ lịch sử (tránh tạo hàng loạt ticket cũ + gửi
       auto-ack cho mọi người gửi trước đây). Chỉ mồi khi cursor còn trinh nguyên — đổi
       mật khẩu / lưu lại sau này KHÔNG reset, không bỏ sót thư.
   - Hoặc đặt env bootstrap cho **worker** (gửi/nhận business mail) và **api** (gửi OTP/reset trực tiếp):
     ```
     IMAP_HRIS_HOST / _PORT(993) / _USER / _PASSWORD / _SECURE=true
     SMTP_HRIS_HOST / _PORT(465 hoặc 587) / _USER / _PASSWORD / _FROM
     IMAP_CNB_*  /  SMTP_CNB_*   (tương tự)
     ```
   - Port: 993/465 ⇒ TLS ngầm; 587 ⇒ STARTTLS bắt buộc (`requiresStartTls`).
4. [ ] **api cũng cần SMTP** (OTP + reset password gửi trực tiếp, không qua outbox). Đặt `SMTP_HRIS_*` cho service `api` hoặc cấu hình DB email_connections — nếu không, quên-mật-khẩu/OTP sẽ không gửi được (lỗi này vừa được vá để không 500, nhưng mail vẫn cần SMTP thật).
5. [ ] `worker`: đặt `POLL_INTERVAL_MS=60000` (NFR3 = 60s; dev đang 5000).

---

## 4. Database

1. [ ] **Đổi mật khẩu Postgres** (không để `hris:hris`):
   - `POSTGRES_PASSWORD` (service postgres) + `DATABASE_URL` (api & worker) phải khớp.
2. [ ] **Migration tự chạy** qua service `migrate` trong `docker-compose.prod.yml` —
   áp generated migrations + `sql/rls-and-extras.sql` (extension + FTS + `audit_log`
   phân mảnh + **RLS + role `app` non-superuser**). Bắt buộc, vì **kết nối superuser
   BỎ QUA RLS** — app phải chạy role `app`.
   - **Không tạo lại bảng mỗi lần.** Drizzle ghi nhật ký migration đã chạy và chỉ áp
     cái MỚI; `rls-and-extras.sql` toàn `IF NOT EXISTS`/`CREATE OR REPLACE`. Dữ liệu
     nằm trong volume `pgdata`, sống qua mọi restart/rebuild.
   - ⚠️ Cần đã sửa `apps/api/nest-cli.json` để build copy file `.sql` vào image
     (đã làm) → **rebuild image api** thì migrate trong container mới chạy được.
3. [ ] **Seed dữ liệu nền** (2 project + categories + role_capabilities + tài khoản SSA đầu tiên):
   ```bash
   docker compose run --rm -e SEED_SSA_EMAIL=ssa@pmh.com.vn -e SEED_SSA_PASSWORD=<mạnh> api node dist/infra/db/seed.js
   # hoặc: pnpm db:seed
   ```
4. [ ] `SEED_DEV_USERS=false` (TUYỆT ĐỐI không seed user `@dev.local` vào prod).
5. [ ] SSA đăng nhập lần đầu → **đổi mật khẩu** ngay (`mustChangePassword`).
6. [ ] **Đóng cổng DB ra ngoài**: bỏ `ports: 5432:5432` ở service postgres trong compose prod (hoặc firewall chặn) — chỉ cho truy cập trong mạng Docker nội bộ.
7. [ ] **Dọn dữ liệu test** nếu deploy từ máy đã chạy thử: xoá ticket `E2E%`, user `@dev.local` (chạy bằng `!` từ bạn — agent bị chặn mass-delete).

---

## 5. File compose cho prod

Tạo `docker-compose.prod.yml` (hoặc sửa thẳng) khác bản dev ở các điểm:

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}   # mạnh, từ .env/secret
    # KHÔNG map 5432 ra host ở prod
    volumes:
      - pgdata:/var/lib/postgresql

  api:
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://hris:${POSTGRES_PASSWORD}@postgres:5432/hris
      APP_BASE_URL: https://hris.pmh.vn
      WEB_ORIGIN: https://hris.pmh.vn
      ATTACHMENT_STORAGE_ROOT: /data/attachments
      # SMTP cho OTP/reset (hoặc cấu hình DB email_connections)
      SMTP_HRIS_HOST: <smtp thật> ; SMTP_HRIS_PORT: '465' ; SMTP_HRIS_SECURE: 'true'
      SMTP_HRIS_USER: <...> ; SMTP_HRIS_PASSWORD: <...> ; SMTP_HRIS_FROM: <...>
    volumes:
      - ../attachments:/data/attachments     # bind mount bền

  worker:
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://hris:${POSTGRES_PASSWORD}@postgres:5432/hris
      POLL_INTERVAL_MS: '60000'
      IMAP_HRIS_*/SMTP_HRIS_*/IMAP_CNB_*/SMTP_CNB_*: <mailbox thật, hoặc dùng UI>
      ATTACHMENT_STORAGE_ROOT: /data/attachments
    volumes:
      - ../attachments:/data/attachments
    restart: always

  web:
    # FE tĩnh; nếu đặt sau reverse proxy ngoài thì không cần map 8080 ra ngoài
    depends_on: [api]

# Xoá hẳn services: mailpit, greenmail
volumes:
  pgdata:
```

Chạy với: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.

---

## 6. Reverse proxy + HTTPS + cookie

- [ ] Đặt **nginx/Traefik/Caddy** trước, terminate TLS (chứng chỉ nội bộ CA hoặc Let's Encrypt nếu ra Internet).
- [ ] Proxy `/`→ web(nginx :80), `/api`→ api :3000. (FE gọi `/api` tương đối nên cùng origin, hạn chế CORS.)
- [ ] Cookie phiên `hris_sid`: `httpOnly`, `sameSite=lax`, **`secure=true` khi `NODE_ENV=production`** → **phải có HTTPS** mới đăng nhập được.
- [ ] `WEB_ORIGIN` = đúng origin HTTPS người dùng truy cập (CORS `credentials:true`).
- [ ] `APP_BASE_URL` = đúng origin đó (link trong mail reset/digest).
- [ ] Giới hạn body-size/proxy timeout phù hợp upload file đính kèm (cap mặc định 50MB, chỉnh ở /admin/attachments).
- [ ] Header bảo mật (HSTS, X-Content-Type-Options…) ở reverse proxy.

---

## 7. Thứ tự khởi chạy lần đầu

> Dùng **`docker-compose.prod.yml`** (file standalone, KHÔNG có greenmail/mailpit).
> Service `migrate` **tự áp schema** trước khi api/worker lên — idempotent, chỉ áp
> migration MỚI, KHÔNG tạo lại bảng cũ (xem mục 4).

```bash
# 1) .env prod: copy mẫu rồi điền giá trị thật (secrets, mật khẩu DB, mailbox, domain)
cp .env.prod.example .env   # rồi sửa .env (chmod 600)

# 2) build + chạy — `migrate` chạy 1 lần tới khi xong, api/worker mới khởi động
docker compose -f docker-compose.prod.yml up -d --build

# 3) seed dữ liệu nền — CHỈ lần đầu (2 project + categories + role_caps + SSA)
docker compose -f docker-compose.prod.yml run --rm migrate node dist/infra/db/seed.js

# 4) kiểm tra
docker compose -f docker-compose.prod.yml ps    # tất cả healthy; `migrate` đã Exit 0
```

Các lần deploy sau (có/không có migration mới): chỉ cần
`docker compose -f docker-compose.prod.yml up -d --build` — `migrate` tự chạy lại,
no-op nếu schema đã mới nhất.

---

## 8. Backup & phục hồi

> 📖 **Hướng dẫn chi tiết + lệnh chuẩn ở `HUONG-DAN-VAN-HANH.md` mục 4 (backup) và mục 5 (restore).**
> Phần này chỉ là checklist.

- [ ] **Backup tự động qua Docker** — service `backup` trong `docker-compose.prod.yml` chạy
      hằng ngày, tạo **1 file duy nhất** `backups/hris-full-<ngày>.tar.gz` gồm DB dump
      custom-format `-Fc` + roles + attachments. KHÔNG cần cron Ubuntu. (Bật sẵn khi `up -d`.)
  ```bash
  # Backup ngay lập tức (restart service = dump liền):
  docker compose -f docker-compose.prod.yml restart backup
  ls -lh backups/    # hris-full-*.tar.gz  (1 file/lần)
  ```
- [ ] ⚠️ **Định dạng DB phải là `-Fc`** (service đã đúng). Dump plain `pg_dump | gzip > .sql`
      **KHÔNG** restore được bằng `pg_restore` — đừng tự chế lệnh plain.
- [ ] **Restore** = `stop api worker` → `./scripts/restore-latest.sh` (tự lấy file mới nhất:
      roles → recreate DB → `pg_restore` → bung attachments) → `up -d api worker`.
      Chi tiết + phương án xoá `pgdata` ở `HUONG-DAN-VAN-HANH.md` mục 5 (kèm cảnh báo `EMAIL_SECRET_KEY`).
- [ ] Cất **off-site**: copy `backups/hris-full-*.tar.gz` **và `.env`** (cất RIÊNG) ra máy/ổ khác.
- [ ] **Diễn tập phục hồi** ít nhất 1 lần (restore vào máy khác, đăng nhập, mở 1 ticket có file).
- [ ] `audit_log` phân mảnh theo năm — **không cần bảo trì thủ công**: `rls-and-extras`
  tự tạo partition tới `now()+5 năm` mỗi lần `migrate`, cộng partition `DEFAULT` hứng
  mọi row ngoài khoảng → không bao giờ lỗi "thiếu partition" (vd 1/1 năm mới).

---

## 9. Hardening / bảo mật (kiểm tra trước go-live)

- [ ] Secrets thật, không commit, quyền file chặt; không log secret/OTP/token (pino redact — đã có).
- [ ] RLS bật, `tickets` FORCE RLS, app chạy role `app` (không superuser/owner).
- [ ] `audit_log` append-only (REVOKE UPDATE/DELETE cho `app`) — đã có trong rls-and-extras.
- [ ] Cổng 5432 không expose ra ngoài; chỉ reverse proxy expose 443.
- [ ] **Trang status công khai** (`/status/:code`) chỉ lộ trạng thái thô + mã + tiêu đề — KHÔNG nội bộ/assignee/nội dung. Xác nhận lại.
- [ ] Mail-bomb throttle, blocklist, junk-rules cấu hình hợp lý (/admin/mail-protection).
- [ ] OTP/reset hoạt động thật (test mục 11).
- [ ] Rà phân quyền: Admin/SSA **không** claim/reply (chỉ điều phối); member/TL trong nhóm mới xử lý.

---

## 10. Vận hành & giám sát

- [ ] Logs: `docker compose logs -f api worker` (pino JSON). Gom về log server nếu có.
- [ ] **Worker heartbeat**: healthcheck đã có (`worker-healthcheck.js`) → stale thì Docker restart. Theo dõi `worker_heartbeats`.
- [ ] **Cảnh báo dung lượng đĩa**: `/admin/attachments` ngưỡng `disk_alert_pct` (mặc định 15%); cảnh báo gửi Admin.
- [ ] Digest/nhắc hạn: kiểm `reminder_config` (digest_hour theo giờ VN) đúng cho 2 project.
- [ ] `restart: always` cho worker (và api/web nếu muốn) để tự dậy sau reboot.

---

## 11. Smoke test sau go-live (bắt buộc)

1. [ ] Truy cập HTTPS → đăng nhập SSA → đổi mật khẩu.
2. [ ] Gửi 1 email thật vào mailbox `hris` → trong ≤ ~60s thành ticket, phân loại đúng category.
3. [ ] Member/TL claim → reply → kiểm requester nhận mail (đúng thread).
4. [ ] Reply & Close / pending (snooze) / wake khi reply.
5. [ ] Upload + tải file đính kèm (signed URL); copy URL sang tab chưa login phải 401.
6. [ ] **Quên mật khẩu**: nhập email thật → nhận mail reset → đặt lại mật khẩu → đăng nhập lại.
7. [ ] Cross-post 2 mailbox (hris + cnb) ra 2 ticket liên kết.
8. [ ] Đổi project (SSA) → dữ liệu cô lập đúng (RLS).
9. [ ] Trang status công khai chỉ lộ thông tin thô.

---

## 12. Rollback

- Lỗi sau deploy code: `docker compose ... up -d --build <service>` lại bản trước (git checkout commit cũ) — migration **forward-only**, KHÔNG rollback schema; nếu migration mới gây lỗi phải có migration sửa tiến.
- Hỏng dữ liệu: dừng app → restore `pgdata` + `attachments` từ backup → chạy lại.

---

### Tóm tắt 10 việc bắt buộc tối thiểu
1. Secrets thật (`SESSION_SECRET`, `HMAC_SIGNING_KEY`, `ATTACHMENT_ENCRYPTION_KEY`, `EMAIL_SECRET_KEY`).
2. Mật khẩu Postgres mạnh + `DATABASE_URL` khớp; đóng cổng 5432.
3. Gỡ `mailpit`/`greenmail`; cấu hình IMAP/SMTP thật 2 project (worker **và** api).
4. `POLL_INTERVAL_MS=60000`, `SEED_DEV_USERS=false`.
5. `APP_BASE_URL` + `WEB_ORIGIN` = domain HTTPS thật.
6. Reverse proxy + **HTTPS** (cookie secure cần https).
7. `db:migrate` rồi `db:seed` (thủ công), đổi mật khẩu SSA.
8. Bind mount `attachments` + backup `pgdata`/`attachments`.
9. Dọn dữ liệu test (`E2E%`, `@dev.local`).
10. Smoke test mục 11.
