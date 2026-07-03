# PLAYBOOK — Kinh nghiệm triển khai dự án full-stack với nhiều agent song song

> Đúc kết từ dự án HRIS/C&B Ticket (NestJS + React + Postgres + Drizzle + Docker Compose),
> nơi hàng chục phiên / nhiều agent thay nhau code mà KHÔNG có ai soi tay từng dòng FE–BE–DB.
> Đây là **playbook chuyển giao** — đọc để biết *cách dựng lưới an toàn* cho dự án chạy nhiều agent đồng thời.
> File này KHÁC `CLAUDE.md` của dự án: `CLAUDE.md` là luật của một dự án cụ thể; file này là *phương pháp*.

---

## 0. Bài học gốc rễ

Khi bạn **không kiểm tra tay được** (nhiều agent chạy song song), thì hai thứ phải kiểm hộ bạn:

1. **LUẬT BẤT BIẾN** — một bộ nhớ chung mọi agent đọc đầu phiên, để không ai tự ý đổi stack / phá kiến trúc.
2. **TEST nhiều lớp** — code sai thì test đỏ, không cần mắt người.

Càng nhiều agent song song, càng phải **ép luật bằng công cụ (lint / type / test / CI), không bằng niềm tin**.
Một agent có thể "quên" văn bản; nó không thể vượt qua `eslint` đỏ hay test fail.

---

## 1. Tài liệu trung tâm kiểu "Lệnh + Bất biến + Cạm bẫy"

Mỗi dự án cần một file (vd `CLAUDE.md`) **≤ 200 dòng**, mọi agent đọc đầu phiên. Vượt 200 dòng → distill, đẩy chi tiết sang file phụ. Cấu trúc đã chứng minh hiệu quả:

| Mục | Nội dung | Vì sao cứu multi-agent |
|---|---|---|
| **Dự án (1 dòng)** | hệ thống làm gì, "khó ở đâu" | Agent định hướng nhanh |
| **Stack đã PIN** | phiên bản cố định, "không tự nâng/đổi" | Agent A nâng lib, agent B vẫn bản cũ → vỡ. PIN chặn từ gốc |
| **Lệnh chuẩn** | install / dev / build / test / migrate / seed | Agent không đoán lệnh, không gõ sai môi trường |
| **LUẬT BẤT BIẾN (LOCKED)** | đánh số, "vi phạm = sai kiến trúc" | Mọi agent tuân cùng một hợp đồng |
| **Cạm bẫy đã biết** | mỗi dòng = một lần đã trả giá | Agent mới không giẫm lại hố cũ — phần đắt nhất |
| **Vai trò tài liệu** | "một sự thật, một nhà" | Tránh 3 agent ghi 3 nơi về cùng một quyết định |

**Nguyên tắc vận hành:**
- **Bồi đắp dần, không distill một cục cuối.** Mỗi lần một agent trả giá cho một bug khó → viết ngay một dòng "cạm bẫy". Đây là tài sản tích lũy.
- **Ép luật bằng công cụ.** Ví dụ thật: ESLint *cấm import tầng DB thô* ngoài một file gateway; lint *ép quy ước đặt tên*. Luật nằm trong tooling thì không ai quên được.
- **"Một sự thật, một nhà":** quyết định *tại sao* ở một file, *luật đầy đủ* ở một file, *làm cái gì* ở backlog/epics, file trung tâm chỉ *nhắc ngắn + link*. Nhiều agent ghi tản mát = mâu thuẫn.

---

## 2. Tháp test — thứ kiểm FE–BE–DB thay con người

Ba lớp, mỗi lớp bắt một loại lỗi khác nhau. Thiếu lớp nào là mù vùng đó.

```
Static  : typecheck (tsc --noEmit) + eslint + unit test   → lỗi kiểu, naming, logic thuần
BE/IT   : integration test với HẠ TẦNG THẬT (DB + mail...) → transaction / RLS / unique / email
FE/e2e  : browser thật lái UI trên stack live              → FE ↔ BE ↔ DB end-to-end
```

Quy tắc chuyển giao:

- **Lớp DB phải test bằng DB thật, KHÔNG mock.** Transaction, ràng buộc unique, phân quyền hàng (row-level security) chỉ lộ bug khi chạy database thật. Dùng *container ephemeral* (mỗi suite tự bật một DB sạch) để không bẩn dữ liệu chung.
- **Test tích hợp chạy tuần tự** (`maxWorkers:1`) nếu mỗi suite bật container riêng — song song sẽ đói tài nguyên → flake (connection reset). Nghịch lý: lớp này *đừng* song song.
- **Teardown dọn bảng con → cha** (theo khóa ngoại), nếu không FK chặn.
- **Test hợp đồng "sống mãi":** với mỗi invariant quan trọng (bảo mật, quyền đọc...), viết một test có **danh sách đăng ký** (vd một mảng `READERS` / `ENDPOINTS`). Thêm endpoint mới mà quên đăng ký → test đỏ. Đây là cách **ép agent tương lai không bỏ sót**, cực hợp khi nhiều agent thêm tính năng song song.
- **Định nghĩa "xong":** một hạng mục chỉ đóng khi test của nó XANH. Không có "code xong, chưa test".

---

## 3. End-to-end (browser thật) — cạm bẫy làm tốn thời gian nhất

Những điều dưới đây khiến e2e đỏ-giả hoặc flaky:

1. **Fixture phải khớp logic sản phẩm.** Bug thật gặp: seed một bản ghi thiếu một cột mà luồng thật luôn set (vd timestamp dùng để sắp xếp) → item bị đẩy xuống trang 2 → test "không thấy" = fail. **Sản phẩm đúng, test sai vì fixture không mô phỏng đúng hành vi thật.** → Seed phải set đủ mọi cột mà luồng thật sẽ set.
2. **Đợi điều kiện, ĐỪNG sleep cứng.** Có worker/async? Poll tới khi điều kiện đạt (`expect(...).toPass({timeout})`), chờ đúng network response trước khi chạm input. Race condition là nguồn flake số 1.
3. **Dữ liệu test dùng ASCII** nếu có vòng mã hóa (email/MIME) — ký tự có dấu bị chuẩn hóa lại (NFC/NFD) → tìm theo text trượt.
4. **Tìm theo text là khớp chuỗi con → dễ trúng 2 phần tử** ("Hộp thư" vs "Bảo vệ hộp thư"). Dùng `exact:true` hoặc regex neo `^...$`.
5. **State phụ thuộc server phải reset ở `afterAll`.** Đổi ngôn ngữ / cấu hình của một tài khoản mà không hoàn nguyên → vỡ suite khác. **e2e không độc lập nếu chia sẻ DB / tài khoản.**
6. **`workers:1`** vì cùng lái một stack live + một DB.
7. **Phần tử phải thực sự nhìn thấy được:** cột bảng cần `width` + cho phép cuộn ngang, nếu không cột flex co về 0 và browser coi là *hidden*.
8. **Phân biệt "test lạc hậu" với "bug sản phẩm".** Trong một đợt tổng rà soát thật: **0 regression sản phẩm** — mọi đỏ là test/fixture lạc hậu so với UI đã đổi. Quy tắc vàng: **test đỏ → đọc lại tiêu chí nghiệm thu TRƯỚC, đừng sửa sản phẩm vội.**

---

## 4. "Single app session" — pattern stack cô lập (chìa khóa cho multi-agent)

Đây là thứ trực tiếp giải bài toán *nhiều agent đụng nhau*. Ý tưởng: mỗi môi trường / mỗi agent có **một stack cô lập hoàn toàn**.

```bash
# Đặt PROJECT NAME riêng cho mỗi môi trường → network + volume + container tách biệt
docker compose -p <ten-moi-truong> -f docker-compose.yml up -d --build

# Cổng phải LỆCH nhau giữa các môi trường (vd dev 8080 vs prod 80/443)
# → nhiều stack chạy đồng thời không tranh cổng, agent này test không xóa DB agent kia
```

Bài học chuyển giao:

- **`-p <tên>` riêng cho mỗi môi trường (dev / e2e / prod).** Mỗi cái có DB + volume riêng. Cô lập = an toàn khi chạy song song.
- **Dải cổng lệch nhau** giữa các môi trường → không tranh cổng.
- **Tách file env theo môi trường, đừng dùng chung mơ hồ.** Cạm bẫy đã dính: file env mặc định trỏ tới **PROD**; khi chạy migrate/seed lên DB dev phải *override connection string thủ công*, nếu không gõ nhầm vào prod. Một file env nhập nhằng = quả bom hẹn giờ.
- **Biết khác biệt môi trường tinh vi.** Ví dụ: trình duyệt coi `localhost` là secure context (gửi cookie Secure qua HTTP) còn `curl` thì không → đừng debug nhầm "vì sao login bằng curl fail".

> Nếu dự án có N agent: cấp cho mỗi agent (hoặc mỗi nhánh) **một project name + một dải cổng + một file env riêng**. Chúng chạy song song mà cô lập tuyệt đối.

---

## 5. Workflow / nhiều agent — khi nào dùng, dùng sao

- **Fan-out hợp khi việc *cần phủ rộng + tổng hợp / kiểm chéo*.** Ví dụ: chạy cả 3 lớp test song song rồi gộp một báo cáo. Mẫu mạnh nhất là **TÌM → KIỂM ĐỐI KHÁNG**: một agent tìm vấn đề, N agent độc lập cố *bác bỏ* nó; đa số bác → loại. Chặn được "phát hiện nghe hợp lý nhưng sai".
- **ĐỪNG song song thứ tranh tài nguyên chung.** Test tích hợp mỗi suite bật một DB container → chạy song song *chậm và flake hơn*. Nhận diện tài nguyên dùng chung (Docker, một DB, một stack live) **trước** khi fan-out.
- **Quy trình an toàn khi không soi tay được:** *chạy hết test → BÁO CÁO các lỗi → CHỜ DUYỆT → mới sửa.* Đừng để agent vừa phát hiện vừa tự sửa hàng loạt — bạn mất kiểm soát phạm vi ảnh hưởng (blast radius).
- **Định nghĩa rõ "ai được ghi vào đâu".** Tương tự luật kiến trúc: các module lá không gọi ngang nhau, chỉ một số "sink" được phép gọi từ mọi nơi. Với agent cũng vậy — phân vùng output để chúng không ghi đè nhau.

---

## 6. Triển khai production (Docker — đã trả giá thật)

- **Ép `NODE_ENV=production` ở compose** (thắng file env dev), nếu không thư viện log có thể bật plugin chỉ-có-ở-dev (devDependency) → **crash khi deploy**.
- **Build tool cần config build riêng** trỏ đúng `rootDir` source, nếu không output ra sai thư mục (`dist/src/main.js` thay vì `dist/main.js`).
- **Kiểm đúng đường mount volume của database** theo phiên bản (mỗi major có thể khác).
- **Tiến trình nền (worker) phải giữ một handle sống** (timer), nếu không nó exit 0 và `restart:always` quay vòng vô tận.
- **Migration là service one-shot chạy TRƯỚC app**, forward-only, **cấm sửa migration đã merge**.
- **Backfill dữ liệu cũ phải là ONE-TIME**, KHÔNG nhét vào script chạy mỗi lần deploy — nó sẽ ghi đè dữ liệu mới mỗi lần khởi động.
- **Seed idempotent cần "conflict target" THẬT** (unique key thật). Bắt nhầm chỉ primary key → re-seed nhân đôi dữ liệu.
- **Rebuild sau mỗi thay đổi code** (container chạy bản build, không phải watch).

---

## 7. Phục vụ file / attachment an toàn (chống "đọc được cả volume vật lý")

**Triệu chứng:** fileserver có thể đọc bất kỳ file nào trên ổ đĩa, không chỉ thư mục lưu trữ.
**Nguyên nhân:** lỗ hổng *path traversal (directory traversal)* — server ghép dữ liệu người dùng vào đường dẫn mà không **giam lại trong thư mục gốc**:

```ts
// SAI — đọc được cả volume
fs.createReadStream(path.join(STORAGE_ROOT, req.params.name));
//   name = "../../../../etc/passwd"   → thoát gốc, đọc file hệ thống
//   name = "/etc/shadow"              → đường tuyệt đối ĐÈ luôn gốc (path.join/resolve)
```
Process chạy bằng user nào thì đọc được **mọi file user đó thấy** (config, key, dữ liệu project khác); trong container mount nhầm cả ổ host thì lộ luôn host.

**6 lớp phòng thủ (chiều sâu) — áp đủ, không chọn một:**

1. **Giam đường dẫn trong gốc — lớp quan trọng nhất.** Resolve rồi *khẳng định nằm trong gốc*, từ chối nếu thoát:
   ```ts
   function resolveSafe(relPath: string): string {
     const rootAbs = path.resolve(storageRoot());
     const abs = path.resolve(rootAbs, relPath);
     if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
       throw new Error(`path escapes storage root: ${relPath}`); // chặn ../ và đường tuyệt đối
     }
     return abs;
   }
   ```
   Mọi thao tác đọc/ghi/stat/xóa đều đi qua hàm này. (Lưu ý `path.join` KHÔNG đủ — đường tuyệt đối vẫn đè; phải `resolve` + kiểm tiền tố.)
2. **Đường dẫn keyed bằng UUID do server sinh; TÊN FILE GỐC không bao giờ nằm trong path.** Input người dùng không bao giờ chạm tới filesystem. Tên gốc chỉ sống ở DB + header `Content-Disposition` lúc tải.
3. **`storagePath` lấy từ DB (server tự tạo), KHÔNG từ request.** Client chỉ gửi *id*, server tra DB ra đường dẫn. Cắt đứt mọi đầu vào tấn công.
4. **Chỉ phục vụ qua tầng app; CẤM web-server (nginx/Apache) serve tĩnh thư mục lưu trữ.** Serve tĩnh = bỏ qua session + phân quyền + audit, và dễ tự mở traversal. Đặt thành luật bất biến.
5. **Nhiều cổng quyền, không lộ tồn tại:** URL ký (HMAC + TTL ngắn, *gắn với user + file id*) → session đăng nhập → phân quyền hàng (RLS). File ngoài tầm nhìn = **404** (không phải 403) để không lộ "file có tồn tại". Copy URL mở khi chưa login = 401.
6. **Header khi serve byte do người ngoài gửi (inline):**
   ```
   X-Content-Type-Options: nosniff                          // cấm browser đoán MIME thành HTML/JS
   Content-Security-Policy: default-src 'none'; sandbox     // vô hiệu hóa nội dung động
   Cache-Control: private, max-age=...                       // không cache chéo user
   ```
   Cộng thêm: **stream chứ không buffer cả file vào RAM** (chống cạn RAM / DoS), và **ghi audit "file.served"** (+ view-log cho dữ liệu nhạy cảm).

**Triển khai container:** mount **một volume dành riêng** cho thư mục lưu trữ (vd `./attachments`), KHÔNG mount cả ổ host. Đường gốc đặt qua biến môi trường để test trỏ vào thư mục tạm. Chạy process bằng user **không phải root**, quyền tối thiểu trên đúng volume đó.

**Test hợp đồng cho file-serving (sống mãi):** thêm test khẳng định `resolveSafe('../../etc/passwd')` *ném lỗi*; mở URL không token → 403; sai token → 403; file ngoài tầm → 404; chưa login → 401. Nhiều agent sửa tầng file về sau mà phá một trong số này → test đỏ.

---

## 8. Checklist khởi động dự án nhiều-agent (rút gọn)

1. [ ] Dựng **tài liệu trung tâm "Luật + Cạm bẫy" ≤200 dòng**, mọi agent đọc đầu phiên.
2. [ ] **Ép luật bằng lint / type / CI**, không bằng văn bản.
3. [ ] **Tháp 3 lớp test** + **test hợp đồng có danh sách đăng ký** cho mỗi invariant.
4. [ ] **DB test bằng container thật**, chạy tuần tự, dọn con→cha.
5. [ ] Mỗi môi trường/agent: **compose project name + dải cổng + file env riêng**.
6. [ ] e2e: **đợi-điều-kiện (không sleep), fixture khớp logic thật, ASCII, reset state afterAll, workers:1**.
7. [ ] Multi-agent: fan-out để **tìm + kiểm chéo đối kháng**; nhưng **báo cáo → chờ duyệt → mới sửa**.
8. [ ] **File-serving: giam đường dẫn trong gốc (`resolveSafe`), path keyed UUID, serve qua app (cấm static), URL ký + session + RLS, header nosniff+sandbox, stream không buffer.**
9. [ ] Deploy: ép `NODE_ENV=production`, migration one-shot forward-only, backfill one-time, rebuild sau mọi đổi.
10. [ ] **Bồi đắp "cạm bẫy" sau mỗi bug khó** — biến mỗi lần trả giá thành một dòng vĩnh viễn.

---

> Quy tắc bao trùm: **test đỏ → nghi test/fixture trước khi nghi sản phẩm.** Trong đợt tổng rà soát thật của dự án nguồn, 100% lỗi là test lạc hậu, 0 regression. Đó là dấu hiệu của một lưới an toàn lành mạnh.
