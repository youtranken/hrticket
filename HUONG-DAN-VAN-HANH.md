# Hướng dẫn Vận hành — HRIS Ticket (Production trên Ubuntu + Docker Engine)

> Tài liệu thực chiến, có giải thích. Áp dụng cho stack chạy bằng `docker-compose.prod.yml`
> trên Ubuntu với **Docker Engine** (KHÔNG phải Docker Desktop).
> Mọi lệnh chạy trong thư mục repo: `/home/hr/hrticket`.

---

## 0. Kiến trúc & vì sao mỗi thứ tồn tại

```
[Người dùng] ──HTTPS 443──> web (nginx: TLS + serve SPA + proxy /api)
                                   │  /api → api :3000
                                   ▼
   worker (poll IMAP mỗi 60s, gửi outbox)     api (REST + OTP/reset)
                                   │                │
                                   ▼                ▼
                     postgres (1 DB "hris", RLS, role "app")
                     attachments (bind mount, file đính kèm)
```

- **postgres** — cơ sở dữ liệu. Dữ liệu sống trong Docker **named volume `app_pgdata`**,
  KHÔNG mất khi rebuild/restart container. Chỉ mất nếu bạn xoá volume thủ công.
- **migrate** — service *một-lần*: áp Drizzle migration + `rls-and-extras.sql` rồi `Exit 0`.
  Idempotent (chỉ áp cái mới, không tạo lại bảng cũ). api/worker đợi nó xong mới chạy.
- **api / worker / web** — build từ source code (khác postgres chỉ *pull* image có sẵn).

**3 bất biến sống còn:**
1. **Thư mục cert nằm NGANG HÀNG với repo** (`../pmh.com.vn`), không nằm trong repo.
2. **Container luôn tên `app-*`** nhờ `name: app` ghim trong compose — dù thư mục tên gì.
3. **Role `app` phải là non-superuser** — vì kết nối superuser BỎ QUA RLS, làm sập phân quyền.

---

## 1. Cấu trúc thư mục (bắt buộc đúng)

```
/home/hr/
├── hrticket/                     ← git clone (source từ GitHub)
│   ├── docker-compose.prod.yml
│   ├── .env                      ← secrets (chmod 600, KHÔNG commit)
│   └── data/                     ← TOÀN BỘ dữ liệu persistent (gitignored)
│       ├── pgdata/               ← DB Postgres (bind mount)
│       └── attachments/          ← file đính kèm
├── pmh.com.vn/                   ← TLS cert, NGANG HÀNG với hrticket/
│   ├── fullchain.pem
│   └── private.key               ← chmod 600
├── backups/                      ← nơi để dump định kỳ (tự tạo)
└── hris-*.dump                   ← dump mang từ máy cũ (dùng 1 lần lúc bootstrap)
```

> 📦 Từ nay mọi dữ liệu sống trong `hrticket/data/` — backup toàn bộ chỉ cần
> `tar czf backup.tar.gz -C /home/hr/hrticket data`. Thư mục `data/` đã được gitignore
> nên không bao giờ lọt vào commit.

> ⚠️ `.env` và `private.key` bắt đầu bằng nội dung nhạy cảm. `ls` thường của Linux GIẤU
> file bắt đầu bằng dấu chấm → luôn kiểm tra bằng `ls -la`.

---

## 2. Deploy lần đầu (máy trắng)

### 2.1 — Cài Docker Engine (không phải Desktop)
Lý do: Desktop gắn với phiên GUI → server reboot lúc 3h sáng thì daemon không tự lên.
Engine là systemd service → `systemctl enable` là tự chạy cùng máy. Xem `setup-docker-engine.sh`.

```bash
sudo systemctl enable --now docker      # bắt buộc: tự chạy sau reboot
docker compose version                  # phải có (plugin v2)
```

### 2.2 — Đặt file đúng chỗ (mục 1), rồi siết quyền
```bash
chmod 600 /home/hr/hrticket/.env
chmod 600 /home/hr/pmh.com.vn/private.key
```

### 2.3 — Kiểm tra config trước khi chạy (bắt lỗi .env sớm)
```bash
cd /home/hr/hrticket
docker compose -f docker-compose.prod.yml --env-file .env config >/dev/null && echo "CONFIG OK"
```
Lỗi `set POSTGRES_PASSWORD in .env` = .env thiếu biến HOẶC dính BOM/CRLF (xem mục 7).

### 2.4 — Bật Postgres, đợi healthy
```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d postgres
until [ "$(docker inspect -f '{{.State.Health.Status}}' app-postgres-1 2>/dev/null)" = "healthy" ]; do
  echo "cho postgres..."; sleep 2
done; echo "POSTGRES HEALTHY"
```

### 2.5 — Tạo role `app` rồi restore dump
```bash
docker exec app-postgres-1 psql -U hris -d hris -c "CREATE ROLE app NOLOGIN;"
docker cp /home/hr/hris-*.dump app-postgres-1:/tmp/dump
docker exec app-postgres-1 pg_restore --no-owner --no-privileges -U hris -d hris /tmp/dump
docker exec app-postgres-1 psql -U hris -d hris -c "SELECT count(*) FROM users;"   # kỳ vọng 28
```
- `CREATE ROLE app` trước: dump có RLS policy nhắc tên role `app` nhưng không chứa role
  (role ở cấp server). Thiếu nó → restore phun `role "app" does not exist`.
- `--no-owner --no-privileges`: bỏ owner/GRANT cũ; quyền cho `app` sẽ do migrate cấp lại.
- **KHÔNG chạy `db:seed`** — dữ liệu đã có trong dump, seed vào sẽ nhân đôi.

### 2.6 — Build + bật cả stack
```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```
Lần đầu build api/web mất 5–10 phút (dịch TypeScript). Thứ tự tự động:
postgres(healthy) → migrate(Exit 0) → api/worker/web.

### 2.7 — Kiểm chứng
```bash
docker compose -f docker-compose.prod.yml ps          # migrate=Exited(0), còn lại healthy
docker exec app-postgres-1 psql -U hris -d hris -c \
  "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname='app';"   # kỳ vọng: app | f | f
curl -kI https://localhost/ | head -3                 # nginx sống, cert load
```
`rolsuper = t` → DỪNG LẠI: RLS đang bị vô hiệu, phân quyền hỏng.

### 2.8 — DNS + đăng nhập + mailbox
- `hrticket.pmh.com.vn` phải trỏ về IP máy prod (DNS nội bộ, hoặc tạm `/etc/hosts`).
- Vào `https://hrticket.pmh.com.vn` → đăng nhập.
- **Nếu secret là MỚI** (khác máy tạo dump): vào `/admin/email-connection` → **nhập lại
  App Password cho CẢ 2 project**. Xem mục 7 (EMAIL_SECRET_KEY) để hiểu vì sao.

---

## 3. Cập nhật code mới từ GitHub

Khi có code mới đã push lên GitHub:

```bash
cd /home/hr/hrticket
git pull origin master
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

Chỉ 2 lệnh. Vì sao an toàn:
- `git pull` chỉ đổi **source code**, KHÔNG đụng `.env`, cert, hay volume `app_pgdata`.
- `up -d --build` rebuild lại image → Docker chỉ dựng lại service nào có thay đổi,
  service không đổi giữ nguyên container.
- **Dữ liệu an toàn**: DB nằm trong volume `app_pgdata`, rebuild container KHÔNG xoá volume.
- **Migration tự chạy**: service `migrate` lên trước api/worker, tự áp migration MỚI (nếu
  code mới có thêm). Idempotent — không có migration mới thì no-op.

Kiểm sau khi update:
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs migrate | tail -20   # xem có áp migration mới không
```

> ⚠️ Trước khi `git pull` một bản lớn / rủi ro: **backup DB trước** (mục 4). Migration là
> forward-only, KHÔNG rollback được schema.

> ⚠️ Nếu bạn có sửa file NGAY TRÊN máy prod (không nên), `git pull` sẽ báo conflict.
> Máy prod chỉ nên là bản sao sạch của GitHub. Muốn sửa → sửa ở nơi khác, push, rồi pull.

---

## 4. Backup DB (TỰ ĐỘNG — chạy trong Docker)

Backup đã **tự chạy trong stack** qua service `backup` (không cần cron Ubuntu). Nó dùng
lại image `postgres:18.4`, nên bật `docker compose up -d` là có luôn. Mỗi lần khởi động
nó backup ngay 1 lần, rồi **mỗi ngày lúc 02:00 giờ VN**, ghi **1 FILE DUY NHẤT**:

`backups/hris-full-<ngày>.tar.gz` — gói đủ để phục hồi:
- `db.dump` — DB **custom format** (`-Fc`), TOÀN BỘ (schema + data + RLS, gồm bảng `users`)
- `roles.sql` — role cấp Postgres (`pg_dumpall --roles-only`) → có sẵn role `app`, KHỎI tạo tay lúc restore
- `attachments/` — toàn bộ file đính kèm
- `MANIFEST.txt` — mô tả nội dung
- Tự xoá file cũ hơn `BACKUP_KEEP_DAYS` (mặc định 14 ngày)

> ⚠️ **`.env` KHÔNG nằm trong gói** (chủ ý). Không có `EMAIL_SECRET_KEY` thì App Password
> mailbox lưu (mã hoá) trong DB **không giải mã được** sau restore → phải nhập lại ở
> `/admin/email-connection`. **Cất `.env` off-site RIÊNG**, cùng nơi an toàn.

> ⚠️ **Đúng định dạng:** DB dump PHẢI là `-Fc` (custom) để `pg_restore` đọc được (mục 5).
> Đừng đổi sang `pg_dump | gzip > .sql` (plain) — không restore bằng `pg_restore` được.

**Xem backup đang chạy / danh sách file:**
```bash
docker compose -f docker-compose.prod.yml logs backup | tail -20   # lịch sử + lần chạy kế tiếp
ls -lh /home/hr/hrticket/backups/                                   # các file hris-full-*.tar.gz
```

**Backup ngay lập tức (không đợi 02:00):** restart service — nó backup liền khi start:
```bash
docker compose -f docker-compose.prod.yml restart backup
```

**Đổi giờ chạy / số ngày giữ:** thêm vào `.env` rồi `up -d`:
```bash
BACKUP_HOUR=2          # 0–23, giờ VN (mặc định 2 = 2h sáng)
BACKUP_KEEP_DAYS=14    # giữ 14 ngày (mặc định)
```

**Kiểm 1 gói đọc được (xem manifest + liệt kê nội dung DB):**
```bash
BK=/home/hr/hrticket/backups/hris-full-YYYY-MM-DD-HHMM.tar.gz
tar tzf "$BK"                                             # thấy db.dump / roles.sql / attachments/
tar xzf "$BK" -O db.dump | docker exec -i app-postgres-1 pg_restore -l | tail -5
```

**Cutover sạch (chuyển hẳn sang máy khác, không để lệch dữ liệu):**
```bash
docker compose -f docker-compose.prod.yml stop worker   # ngừng nhận mail mới
docker compose -f docker-compose.prod.yml restart backup # tạo gói mốc cắt
# — và ĐỪNG bật lại worker máy cũ nữa
```
Lý do: nếu mail vào SAU lúc dump, `imap_cursor` trong dump còn ở uid cũ → máy mới poll lại
tạo trùng ticket. Dừng worker trước khi dump = có một mốc cắt sạch.

> 💾 **Cất off-site:** `backups/` nằm cùng máy prod. Định kỳ copy `hris-full-*.tar.gz` ra ổ
> khác / máy khác (`scp`, USB…) — **kèm bản `.env`** cất riêng — đừng chỉ để 1 chỗ.

---

## 5. Restore / Import một dump vào hệ thống ĐANG chạy

Khác mục 2.5 (máy trắng). Ở đây DB đã có dữ liệu → phải xoá sạch trước, nếu không
`pg_restore` sẽ đụng bảng đã tồn tại. Cách an toàn nhất: **làm lại volume từ đầu**.

```bash
cd /home/hr/hrticket

# 1) Hạ stack + XOÁ dữ liệu DB hiện tại (mọi dữ liệu mất — chắc chắn đã backup!)
docker compose -f docker-compose.prod.yml down
sudo rm -rf /home/hr/hrticket/data/pgdata

# 2) Bật lại mỗi postgres (volume mới, trống)
docker compose -f docker-compose.prod.yml --env-file .env up -d postgres
until [ "$(docker inspect -f '{{.State.Health.Status}}' app-postgres-1 2>/dev/null)" = "healthy" ]; do sleep 2; done

# 3) Giải nén gói 1-file ra thư mục tạm
BK=/home/hr/hrticket/backups/hris-full-YYYY-MM-DD-HHMM.tar.gz
mkdir -p /tmp/restore && tar xzf "$BK" -C /tmp/restore   # → db.dump, roles.sql, attachments/

# 4) Roles (có sẵn role `app`) + restore DB. Lỗi "role đã tồn tại" (vd hris) là VÔ HẠI — bỏ qua.
docker cp /tmp/restore/roles.sql app-postgres-1:/tmp/roles.sql
docker exec app-postgres-1 psql -U hris -d postgres -f /tmp/roles.sql || true
docker cp /tmp/restore/db.dump app-postgres-1:/tmp/dump
docker exec app-postgres-1 pg_restore --no-owner --no-privileges -U hris -d hris /tmp/dump

# 5) Attachments — xoá thư mục cũ rồi bung từ gói vào.
sudo rm -rf /home/hr/hrticket/data/attachments && mkdir -p /home/hr/hrticket/data/attachments
sudo cp -a /tmp/restore/attachments/. /home/hr/hrticket/data/attachments/

# 6) Bật lại cả stack (dùng .env đã cất off-site — KHÔNG nằm trong gói)
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
rm -rf /tmp/restore
```

> ℹ️ `roles.sql` nối vào DB `postgres` (không phải `hris`) vì nó tạo role cấp cluster. Nếu
> gói cũ không có `roles.sql` (bản trước), thay bước 4 bằng `CREATE ROLE app NOLOGIN;` thủ công.

> ℹ️ File `.dump` (DB) và `.tar.gz` (attachments) do service `backup` tạo cùng mốc thời gian
> (mục 4) — chọn cặp CÙNG NGÀY để DB và file khớp nhau.

> 🔑 **CẢNH BÁO EMAIL_SECRET_KEY:** dump chứa App Password mailbox đã mã hoá bằng
> `EMAIL_SECRET_KEY` của máy TẠO dump. Nếu `.env` máy này có `EMAIL_SECRET_KEY` KHÁC,
> mailbox sẽ không giải mã được → email chết ÂM THẦM (worker vẫn healthy, chỉ là không
> nhận/gửi mail). Cách xử: hoặc dùng đúng `EMAIL_SECRET_KEY` khớp với dump, hoặc sau
> restore vào `/admin/email-connection` nhập lại App Password cho cả 2 project.

---

## 6. Lệnh vận hành thường dùng

```bash
# Trạng thái + log
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api worker      # theo dõi realtime
docker compose -f docker-compose.prod.yml logs web | tail -20

# Khởi động lại 1 service (không mất dữ liệu)
docker compose -f docker-compose.prod.yml restart worker

# Vào psql
docker exec -it app-postgres-1 psql -U hris -d hris

# Hạ / lên toàn bộ (volume GIỮ NGUYÊN vì không có -v)
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml --env-file .env up -d

# Dọn image cũ sau nhiều lần build
docker image prune -f
```

> `down` (không kèm `-v`) chỉ xoá container, GIỮ volume `app_pgdata`. `down -v` mới xoá
> volume = mất DB. Nhớ kỹ sự khác biệt này.

---

## 7. Xử lý sự cố

**`error getting credentials ... docker-credential-desktop`**
Tàn dư Docker Desktop trong `~/.docker/config.json`. Xoá dòng `"credsStore": "desktop"`
(giữ phần còn lại của file). Hoặc `rm ~/.docker/config.json` (chỉ pull image công khai,
không cần credential).

**`.env` không đọc được / `set POSTGRES_PASSWORD in .env` dù đã điền**
File `.env` dính **BOM** hoặc **CRLF** (thường do soạn trên Windows). Kiểm:
```bash
file .env                    # phải là "ASCII text", KHÔNG có "with BOM"/"CRLF"
sed -i '1s/^\xEF\xBB\xBF//' .env    # bỏ BOM
sed -i 's/\r$//' .env               # CRLF → LF
```

**nginx chết: `cannot load certificate ... Is a directory`**
Cert để sai chỗ → Docker tạo thư mục rỗng thay cho file. Cert phải ở
`/home/hr/pmh.com.vn/` (ngang hàng repo), có đúng `fullchain.pem` + `private.key`.

**Build lỗi ở bước `pnpm ... build` (Dockerfile RUN)**
- Nếu source để trên **volume/mount Windows** (WSL, ổ /mnt/c): fs ghi lỗi → chuyển source
  sang filesystem Ubuntu thật (`/home/...`).
- Nếu máy **ít RAM** (tsc/vite bị kernel giết, log "Killed"/"heap out of memory"): tạo swap
  ```bash
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  ```

**Đăng nhập được nhưng ai cũng thấy mọi ticket (RLS thủng)**
Role `app` đang là superuser hoặc chưa được `SET LOCAL ROLE`. Kiểm mục 2.7; role phải
`rolsuper=f`. Nếu sai, chạy lại `migrate` (áp `rls-and-extras.sql`).

**Cổng 80/443 bị chiếm**
```bash
sudo ss -tlnp | grep -E ':(80|443)\s'    # xem process nào giữ
```
Tắt web server đang chiếm (apache2/nginx host), hoặc đổi cổng trong `.env`
(`WEB_PUBLIC_PORT`, `WEB_HTTP_PORT`, và cập nhật `APP_BASE_URL`/`WEB_ORIGIN` kèm cổng).

**Sau reboot máy, app không lên**
Kiểm `systemctl is-enabled docker` phải là `enabled`. Container có `restart: unless-stopped`
/ `always` nên tự lên khi daemon chạy. Nếu daemon không tự chạy → `sudo systemctl enable docker`.

---

## Phụ lục — Sơ đồ quyết định nhanh

| Tình huống | Làm gì |
|---|---|
| Có code mới trên GitHub | Mục 3: `git pull` + `up -d --build` |
| Backup định kỳ | Mục 4: `pg_dump -Fc` |
| Khôi phục từ backup | Mục 5: down + rm volume + restore |
| Chuyển sang máy mới | Mục 2 (deploy lần đầu) với dump mới nhất |
| Đổi secret/domain | Sửa `.env`, `up -d` lại; nếu đổi EMAIL_SECRET_KEY → nhập lại App Password |
| App chết sau reboot | Kiểm `systemctl is-enabled docker` |
