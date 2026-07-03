# Đợt cập nhật PROD đang chờ — Mô tả chi tiết

> Gồm ĐỢT 1 (Mục 1–5, threading + cross-post + forward) và ĐỢT 2 (Đơn 4–12, 2/7/2026)
> ở cuối file. Tất cả chung một lần deploy (rebuild api + worker + web).

> Trạng thái: **CHƯA áp lên prod** — đã code xong, kiểm chứng trên stack e2e cô lập
> (`hris-e2e`, cổng 18080/13025/18025). Bằng chứng: IT 21/21 pass (threading, reply-ack,
> reopen, intake, loop) + e2e `mail-thread.e2e.ts` pass + ảnh demo trong `docs/demo-shots/`.
>
> Bối cảnh: các thay đổi Gmail-threading đợt đầu (subject `Re:`, footer mã ticket, quote
> lồng, To/CC thành participant) **đã nằm trên prod** từ đợt deploy trước. 4 mục dưới đây là
> phần phát sinh SAU đó (sửa lỗi tìm thấy khi test qua lại + 2 yêu cầu mới: mở cross-post,
> reply-all theo mail gần nhất).

---

## Mục 1 — Rebuild image `api` + `worker` (thay đổi backend)

### 1a. Fix: quote rỗng khi trích dẫn mail chỉ-có-text 🐛
- **Hiện tượng**: mail người dùng gửi từ client chỉ có bản text (không HTML) khi được
  hệ thống trích dẫn trong thư trả lời → ra **khung quote rỗng**.
- **Nguyên nhân**: mail text-only lưu `body_html_safe = ''` (chuỗi rỗng, không phải null)
  → toán tử `??` không rơi về bản text.
- **Sửa**: 1 dòng trong `reply.service.ts` (`??` → `||` + trim).
- **Bằng chứng**: ảnh `14-mail-4.png` — câu *"Da vang, em cam on anh chi nhieu a!"* hiện đủ.

### 1b. Cross-post: MỞ cho cả 2 project cùng xử lý 🔓 (yêu cầu mới)
- **Trước**: mail gửi cùng lúc 2 hộp thư tạo 2 ticket link nhau; bên nào nhận trước thì
  **bên kia bị khóa** (không claim/trả lời/đổi trạng thái được).
- **Sau**: cả HRIS lẫn C&B đều xử lý ticket phía mình bình thường:
  - Gỡ 4 điểm chặn: trả lời, nhận việc, giao việc, chuyển trạng thái.
  - **Mỗi bên gửi email bằng mailbox của chính mình** (HRIS gửi từ hộp HRIS, C&B từ hộp C&B —
    vốn là hành vi sẵn có, nay không còn bị khóa).
  - **Hội thoại gộp 2 chiều**: mở ticket bên nào cũng thấy đủ mail trao đổi của CẢ 2 bên;
    mail của bên kia gắn tag cam `HRIS`/`CNB`. Ghi chú nội bộ KHÔNG chia sẻ qua bên kia.
    Mail gốc (trùng Message-ID 2 bên) được khử trùng lặp.
  - Giữ lại tính năng dọn dẹp: 1 bên đóng xong mà bên kia **chưa ai nhận** → tự đóng giúp
    (bên đang có người xử lý thì không bao giờ bị đụng).
- **Phía người gửi**: cả 2 luồng trả lời đều `Re:` + bám header mail gốc → Gmail của họ
  vẫn gộp thành MỘT hội thoại dù 2 phòng ban cùng trả lời.
- **Bằng chứng**: ảnh `06-crosspost-cnb-view.png`, `07-crosspost-hris-view.png`.
- File: `cross-post-lock.ts`, `reply/assignment/ticket-status.service.ts`,
  `tickets-read.service.ts` (merge), FE đi kèm ở Mục 2.

### 1c. Ô To/CC/BCC prefill theo MAIL GẦN NHẤT ✉️ (yêu cầu mới)
- **Trước**: To = người gửi gốc, CC = gom tất cả participant từng thấy.
- **Sau**: giống bấm **Reply-All trên mail mới nhất** của Gmail:
  - Mail đến gần nhất → To = người gửi + những người ở ô To của họ; CC = CC của họ.
  - Mình nói sau cùng → giữ nguyên To/CC/**BCC** của lần gửi trước.
  - **Loại thư máy** (auto-ack của hệ thống, out-of-office) và ghi chú nội bộ khỏi khái niệm
    "mail gần nhất" — nếu không, ack (chỉ gửi requester) sẽ làm rớt hết CC.
  - Mailbox hệ thống của 2 project luôn bị loại (chống tự gửi vòng).
- File: `reply.service.ts` (`getDefaults`), FE seed BCC ở Mục 2.

### 1d. BỎ duyệt người lạ (pending approval) 🚪 (yêu cầu mới)
- **Trước**: địa chỉ mới xuất hiện trên thread bị treo `pending_approval`, nhân viên phải
  bấm Duyệt/Từ chối thì họ mới được vào reply-all.
- **Sau**: mọi địa chỉ trên mail (From/To/CC) thành participant **active ngay** — vào
  reply-all luôn, không cần duyệt.
- **Giữ 1 chốt an toàn**: người **hoàn toàn lạ** gửi mail vào ticket **đã đóng** → mail vẫn
  ghi nhận vào thread nhưng KHÔNG tự reopen (chống spam mở lại ticket). Modal xác nhận khi
  nhân viên tự gõ địa chỉ mới lạ lúc soạn thư vẫn giữ (chống gõ nhầm).
- File: `append-message.usecase.ts`; test `IT-THREAD-004` viết lại theo hành vi mới.

> `worker` dùng chung code intake/ack nên phải rebuild cùng `api`.
> Lưu ý vận hành: worker quét IMAP **mỗi 60s** (NFR3, `POLL_INTERVAL_MS=60000`).

---

## Mục 2 — Rebuild image `web` (thay đổi giao diện)

1. **Fix lộ chữ `class="gmail_quote">`** khi bấm "••• Hiện nội dung trích dẫn": bộ tách
   quote cắt HTML giữa thẻ. Sửa regex trong `SafeMessageBody.tsx`. (Prod hiện đang dính.)
2. **CSS vạch quote `│`** cho blockquote trong mail (`.email-body blockquote`) — mail đến từ
   Gmail bị sanitizer gỡ style border nên vạch lồng biến mất; nay áp lại thống nhất.
3. **Gỡ banner "ticket bị khóa cross-post"** + mở lại thanh thao tác/ô soạn thư (đi cùng 1b).
4. **Tag cam `HRIS`/`CNB`** trên bubble mail đến từ project bên kia (đi cùng 1b).
5. **Ô BCC tự điền** từ reply-defaults (đi cùng 1c).
6. i18n: thay 2 key khóa cross-post bằng key tooltip tag mới.

---

## Mục 3 — Migration `0012_participants_all_active` (dữ liệu)

```sql
UPDATE participants SET status='active' WHERE status='pending_approval';
```
- Chuyển các participant đang **chờ duyệt** còn tồn trong DB sang active (đi cùng 1d).
- Người đã bị **Từ chối** trước đây giữ nguyên (tôn trọng quyết định cũ).
- Tự chạy qua container `migrate` one-shot khi `up` — không cần thao tác tay.

---

## Mục 4 — Sửa câu chữ template thư xác nhận (DB prod, 1 lệnh UPDATE)

- Thư auto-ack đang ghi: *"Vui lòng trả lời ngay trên email này **(giữ nguyên mã #NNNNN ở
  tiêu đề)**…"* — cụm trong ngoặc đã **sai hướng dẫn** vì mã ticket không còn nằm ở tiêu đề
  (để Gmail gộp thread); nhận diện reply chạy bằng header ẩn, người dùng không cần giữ gì.
- Lệnh (chỉ gỡ đúng cụm ngoặc, VI + EN):
```sql
UPDATE email_templates SET
  body_vi = replace(body_vi, ' (giữ nguyên mã {{ticketCode}} ở tiêu đề)', ''),
  body_en = replace(body_en, ' (keep {{ticketCode}} in the subject)', '')
WHERE key = 'auto_ack';
```
- Seed cho cài đặt mới đã sửa sẵn trong code (`seed.ts`).

---

## Mục 5 — Tính năng mới: Forward email ↪️ (yêu cầu mới)

- **Là gì**: trên MỖI bubble mail trong hội thoại (trừ ghi chú nội bộ và mail của
  project bên kia trong cặp cross-post) có link **Forward** → mở tab "Forward" ở ô
  soạn thư: To/CC/BCC **trống tự gõ**, kèm lời nhắn (không bắt buộc).
- **Mail gửi đi** đúng kiểu Gmail: tiêu đề `Fwd: <tiêu đề>` (không `[#code]`), thân =
  lời nhắn + footer mã ticket + khối
  `---------- Forwarded message / Thư chuyển tiếp ----------` (Từ/Ngày/Tiêu đề/Đến/Cc)
  + nguyên văn mail được forward. BCC của mail gốc KHÔNG bao giờ lộ trong khối header.
- **Người nhận forward thành participant ACTIVE ngay** → lọt vào reply-all sau này;
  nếu họ trả lời, mail bám References của thư forward và **tự nối về đúng ticket**.
- **Quyền = như trả lời**: assignee / TL-trong-nhóm (Admin/SSA điều phối, không gửi).
  Forward ticket chưa ai nhận → tự claim (giống reply). Người nhận MỚI vẫn qua modal
  xác nhận (chống gõ nhầm). Ô To/CC/BCC gợi ý của lần trả lời sau sẽ bám theo thư
  forward (đúng luật "mail gần nhất" của Mục 1c).
- **Giới hạn v1**: tệp đính kèm của mail gốc KHÔNG tự gửi kèm (có ghi chú ngay trên UI).
- **Bằng chứng**: e2e `apps/web/e2e/forward.e2e.ts` (Fwd: subject + khối forwarded +
  participant active + reply nối về ticket) — chạy trên stack e2e cô lập.
- File: `reply.service.ts` (`forward()`, `forwardedBlock`), `compose.controller.ts`
  (`POST /tickets/:id/forward`), FE `ComposeBox/MessageBubble/TicketDetailPage`,
  `lib/tickets.ts`, i18n (nhãn tiếng Việt dùng chữ "Forward" theo yêu cầu).
- Deploy: đi chung rebuild `api` (Mục 1) + `web` (Mục 2) — không cần migration.

---

# ĐỢT 2 — Đơn 4→12 (2/7/2026)

## Đơn 4 — Disable Pool (tắt nhóm không dùng nữa) 🚫
- Backend vốn đã bỏ qua category `disabled` khi phân loại mail → mail mới **tự rơi vào
  "Khác"**; ticket đang có giữ nguyên, xử lý nốt bình thường.
- Bổ sung: nút **Tắt pool / Bật lại** ngay trên bảng Danh mục (`/admin/categories`),
  kèm Popconfirm giải thích. Pool tắt cũng biến khỏi picker gán/đổi nhóm (sẵn có).

## Đơn 5 — Mở claim cho Admin/TL + ép chọn nhóm khi member nhận từ "Khác" 🔓
- **Admin/SSA nhận (claim) được ticket bất kỳ đâu trong project; TL nhận theo NHÓM
  ĐƯỢC THÊM VÀO (+ pool "Khác")** — trước đây Admin bị cấm claim, TL không có nút Nhận.
  Muốn TL nhận pool nào thì thêm TL vào nhóm đó ở /admin/groups.
- **RLS giữ nguyên need-to-know**: TL/member vẫn chỉ thấy ticket nhóm mình — KHÔNG mở
  tầm nhìn toàn project (đã chỉnh lại theo xác nhận 3/7).
- **Ai claim thì người đó trả lời**: gate reply đổi thành assignee-first — Admin đã nhận
  ticket thì soạn/gửi email + forward như member (Admin KHÔNG phải assignee vẫn bị chặn
  như cũ). Gán CHO admin/ssa qua "Gán cho…" vẫn bị cấm.
- **Gán việc → thẳng "Đang xử lý"**: manual assign không còn dừng ở "Đã giao"
  (open/assigned → in_progress). Auto-assign của hệ thống giữ nguyên "Đã giao".
- **Member nhận từ pool "Khác" bắt buộc chọn nhóm đích**: 1 nhóm → tự điền; nhiều nhóm →
  modal bắt chọn (needsCategory); 0 nhóm → 422 không cho nhận. TL/Admin được phép giữ "Khác".
- File: `assignment.service/controller`, `ticket.state-machine`, `rls-and-extras.sql`,
  FE `AssignControls`, `TicketListView` (nút Nhận cho mọi role + modal chọn nhóm),
  `ComposeBox`/`TicketDetailPage` (admin-assignee thấy tab Trả lời/Forward).

## Đơn 6 — Nút "Gửi email" kèm chuyển trạng thái ✉️➡️
- Nút Gửi email có mũi tên: **Gửi & Chờ phản hồi** (bắt chọn ngày hẹn, 422 nếu ngày quá
  khứ) và **Gửi & Đã giải quyết**. Tickbox **"Đóng ticket sau khi gửi"** giữ nguyên và
  thắng khi tick chung. Dropdown trạng thái phía trên GIỮ NGUYÊN (theo xác nhận).
- Gửi + đổi trạng thái trong CÙNG một transaction; resolved/closed cũng tự dọn sibling
  cross-post chưa ai nhận (trước đây Reply&Close bỏ sót bước dọn này — đã vá luôn).

## Đơn 7 — Đánh dấu Spam ⇒ chặn người gửi luôn 🛑
- Menu ⋯ "Đánh dấu Spam thread": bật → **email người gửi vào blocklist** của project
  (mail sau của họ bị chặn ngay ở cổng quét, không tạo ticket); tắt → gỡ khỏi blocklist.
  Cả hai chiều đều ghi audit; message trên UI nói rõ đã chặn/gỡ.

## Đơn 8 — Danh sách mặc định ẨN ticket Đóng 🗂️
- `/inbox` (view Tất cả) không hiện ticket Đóng nữa; muốn xem lại → filter Trạng thái =
  Đóng. Các tab mine/pool/pending vốn đã tự ghim trạng thái, không đổi.

## Đơn 10 — Ẩn chip "Sẵn sàng" trên header 👻
- Gỡ chip Sẵn sàng/Vắng mặt khỏi header (tính năng không dùng). Cơ chế "vắng mặt" phía
  server (auto-assign né người vắng) vẫn còn nguyên, chỉ ẩn UI.

## Đơn 11 — Page size 20 mặc định, mở tới 100 📄
- Bộ chọn số dòng/trang hiện cố định các mốc **20 / 50 / 100** và luôn hiển thị (kể cả
  1 trang). BE vốn đã cho max 100.

## Đơn 12 — Digest hằng ngày CHỈ gửi Admin, 2 phân mục 📬 (chốt 3/7)
- **Một email tổng hợp/ngày cho MỖI Admin của project**, gửi sau mốc **hh:mm VN**
  (mặc định **08:30**, config được giờ + phút). Member/TL **không nhận mail digest
  nữa** — tín hiệu của họ là dòng đỏ quá hạn ngay trên danh sách.
- Nội dung 2 phân mục:
  1. ⏳ **Pool chưa ai nhận ≥ N ngày** (mặc định **2**, config `poolUnclaimedDays`) —
     ticket pool KHÔNG cần chờ quá mốc tồn đọng mới bị nêu tên;
  2. 🐌 **Đã giao quá M ngày chưa xong** (dùng `overdueDays`, tính từ **lúc giao**;
     ticket hẹn snooze còn trong hạn được miễn, quá hẹn thì bị nêu) — **muốn mốc
     4 ngày thì đặt `overdueDays = 4` trong /admin/reminders** (mốc này cũng là mốc
     highlight đỏ trên danh sách).
- **Gỡ mail "escalation quá hạn" gửi riêng TL** (nội dung đó giờ nằm ở mục 2 của
  digest Admin). Nhắc snooze-đến-hạn cho người xử lý (FR50) GIỮ NGUYÊN.
- Migration `0013_digest_split` thêm 2 cột config (`digest_minute` mặc định 30,
  `pool_unclaimed_days` mặc định 2) — tự chạy khi `up`, không phá dữ liệu.
- UI `/admin/reminders` có đủ 5 ô: mốc đã-giao (ngày), mốc pool (ngày), giờ + phút
  gửi, max ticket mỗi mục + công tắc bật/tắt.
- Test: `digest.it-spec.ts` viết lại 5 case (2 phân mục, member không nhận mail,
  cổng hh:mm, cap N + tắt, miễn snooze-trong-hạn).

## Đơn 9 — trả lời (không đổi code)
- Cơ chế trùng tiêu đề: dedup theo (Message-ID, mailbox), KHÔNG gộp theo tiêu đề —
  2 mail cùng tiêu đề khác Message-ID = 2 ticket, đúng thiết kế (xem hội thoại).

---

# ĐỢT 3 — Đơn 13–14 (3/7/2026): Report v2 — thiết kế lại toàn trang

## Đơn 13 + redesign — Report v2 📊 (đã chốt mock, code xong 3/7)
**Phân quyền (đơn 13):**
- **Member giờ CŨNG vào được /reports** (trước đây menu ẩn + BE 403), nhưng chỉ thấy
  **báo cáo của chính mình**: BE ghim cứng `assignee = chính họ` ở MỌI endpoint
  (kể cả khi cố truyền assigneeId người khác) — không dựa RLS vì RLS member thấy cả
  nhóm. FE ẩn bảng nhân viên + ô lọc. Admin/TL có ô lọc **nhân viên**; TL vẫn bị RLS
  giới hạn nhóm mình.

**Giao diện mới (đã duyệt mock):**
- **Chọn NĂM** (2026, 2027… — năm cũ giữ nguyên, tính trực tiếp từ ticket nên chọn
  lại xem/xuất đầy đủ) + phân kỳ **Cả năm / Quý / Tháng**.
- **4 thẻ KPI**: Tổng đã xử lý (Giải quyết + Đóng, có % so cùng kỳ năm trước) ·
  Đang xử lý (kèm số mở lại + chờ phản hồi) · Quá hạn (kèm "lâu nhất X ngày") ·
  **Thời gian xử lý trung bình** (so cùng kỳ) — kèm sparkline.
- **Xu hướng**: 2 đường Tạo mới vs Đã xử lý + chấm đỏ kỳ có quá hạn; nút gộp
  Tuần/Tháng/Năm (ISO `2026-W27`, giờ VN); bảng số thu vào nút "Xem bảng".
- **Hiện trạng ticket** (MỚI): thanh chồng 6 trạng thái + danh sách bấm được →
  mở Hộp thư lọc đúng trạng thái + khoảng ngày.
- **Theo nhóm**: thanh chồng 3 màu (đã xử lý / đang làm / quá hạn), bấm → drill Hộp thư.
- **Hiệu suất nhân viên**: bảng xếp hạng Đang giữ · Đã xử lý · Quá hạn ·
  **TG xử lý TB** · **% đúng hạn**; bấm dòng → Hộp thư lọc người đó (dòng pool → view pool).
- **Dải chất lượng**: lượt mở lại (cảnh báo >5%), junk đã chặn, chờ phản hồi quá hẹn.
- Export Excel/CSV mọi bảng theo cột MỚI + đúng bộ lọc; member export = self.

**Kỹ thuật:**
- Migration **0014_resolved_at**: cột `tickets.resolved_at` + backfill từ `closed_at`
  cho ticket đã đóng (ticket đang ở "Đã giải quyết" từ trước không có mốc → để NULL,
  loại khỏi trung bình). **Trigger `trg_tickets_resolved_at`** (rls-and-extras.sql,
  idempotent): vào resolved/closed → đóng dấu `now()`; reopen → xóa để lần giải quyết
  sau đóng dấu lại. Nhờ trigger nên KHÔNG phải sửa ~6 service đổi status.
- Endpoint mới `GET /api/reports/summary` (KPI + hiện trạng + chất lượng + minYear
  + delta cùng kỳ qua `prevFrom/prevTo`); `by-time/by-category` thêm cột `handled`;
  `by-staff` định nghĩa lại: `holding`/`handled`/`overdue`/`avgDays`/`onTimePct`.
- "% đúng hạn" = giải quyết trong `overdue_days` của project. RLS KHÔNG đổi.
- Test: IT-REPORT-001→006 (6/6, gồm summary + trigger) + e2e `reports.e2e.ts` 2/2
  + phasec-smoke/i18n pass.

## CODE REVIEW Report v2 (chiều 3/7, 26 agent) — 10 finding, fix 8 + chấp nhận 2
1. **Member leak junk + minYear** ở summary (RLS member thấy cả nhóm) → ghim self cả 2.
2. **Overdue lệch worklist chuẩn** (thiếu miễn-snooze + mốc snooze_until) → dùng đúng
   mirror của tickets-read 5.6 cho mọi bảng.
3. **Thiếu đăng ký FR65 READERS** → thêm `report:by-category` + `report:summary`
   vào sweep vis.it-spec (IT-VIS-002 xanh).
4. **CHẤP NHẬN (đúng thiết kế):** member bị gỡ nhóm mất ticket ĐÃ ĐÓNG khỏi report
   của chính mình (carve-out RLS loại closed) — need-to-know FR65, có comment chốt
   trong service để đời sau khỏi "sửa".
5. **Drill-down của member mở list cả nhóm** → mọi link drill ghim `assigneeId=self`.
6. **Export by-staff dòng pool in số thật khác màn hình (—)** → export để trống như UI.
7. **Ticket đang 'resolved' lúc migration không bao giờ được đóng dấu** → trigger thêm
   nhánh: vào closed mà resolved_at NULL thì đóng dấu muộn (muộn hơn KHÔNG có).
8. **CHẤP NHẬN:** backfill resolved_at = closed_at cho ticket đóng TRƯỚC migration là
   xấp xỉ (ai resolved lâu rồi mới đóng sẽ bị tính dài hơn thật) — dữ liệu cũ không
   có mốc chính xác, migration đã áp, tự pha loãng theo thời gian.
9. **snoozeDue lệch 1 ngày** (`<` vs `<=` của worklist) → dùng `<=` (đến hẹn HÔM NAY là due).
10. **Cửa sổ so-cùng-kỳ nuốt 29/2** khi shift chuỗi năm → tính lại bằng `rangeFor(year−1)`.

## Backlog CR cũ (3/7 chiều) — xử lý cùng đợt
- **CR-2**: picker "Theo user" ở Nhóm không còn liệt kê tài khoản bị khóa.
- **CR-4 (đào sâu)**: assign ticket **Chờ phản hồi** trước đây 409 nhưng claim-over thì
  ĐƯỢC (bất đối xứng) → giờ assign được, GIỮ nguyên trạng thái + lịch hẹn (người mới
  thừa kế ngày hẹn) — đóng lỗ hổng "người giữ nghỉ việc khi ticket đang chờ KH".
  Test IT-MASSIGN-004 khóa hành vi. FE AssignControls mở nút cho pending.
- **CR-7**: bảng ticket có lại **sort theo cột**: thêm cột "Tạo lúc" + sorter ở cả
  cột Trạng thái (điều khiển qua URL `sort/dir`, share link giữ chiều sort).
- **Resnapshot drizzle**: migration `0015_resnapshot_sync` (no-op, IF NOT EXISTS) đồng bộ
  snapshot — `db:generate` sạch trở lại, hết cảnh sinh migration trùng.

## Đơn 14 — User ở 2 pool thì report tính thế nào? (không đổi code)
- Report đếm **theo ticket**, mỗi ticket có đúng 1 nhóm + tối đa 1 người giữ →
  **không bao giờ đếm đôi**. User ở 2 pool = 1 dòng duy nhất ở "Khối lượng theo
  nhân viên", cộng dồn ticket từ cả 2 pool. Muốn tách theo pool: lọc user đó
  (đơn 13) rồi nhìn bảng "Theo nhóm" — ra đúng phân bổ 2 pool của người ấy.

---

# CODE REVIEW TRƯỚC DEPLOY (3/7/2026) — 10 finding, đã fix hết

Workflow review đa-agent (37 agent, verify độc lập từng finding) trên toàn changeset:
1. **Lộ BCC xuyên project ở merge cross-post** → sibling message giờ bị xóa `bccAddrs`.
2. **Địa chỉ bị TỪ CHỐI lọt lại reply-all defaults** → loại `rejected` khỏi defaults; gửi
   lại cho địa chỉ rejected bắt buộc qua modal xác nhận (confirm = tái kích hoạt).
3. **Bỏ dấu spam xóa nhầm blocklist do Admin thêm tay** → chỉ xóa row `spam_thread %`,
   và chỉ khi người gửi không còn thread spam nào khác.
4. **Digest bỏ sót ticket vô chủ không-open** (vd gỡ user khỏi project) → mục 1 gom mọi
   ticket vô chủ chưa kết thúc (kể cả đến hẹn snooze).
5. **Forward được trên ticket Đóng qua API** → 409 INVALID_TRANSITION như claim.
6. **Mất nơi tắt trạng thái vắng mặt** → control Vắng mặt chuyển vào dropdown hồ sơ
   (góc phải), header vẫn không còn chip.
7. **FE hiện tab Trả lời/Forward cho người server sẽ 403** → FE mirror đúng gate
   (assignee bất kể role, hoặc TL-trong-nhóm).
8. **Modal xác nhận nổi mọi lần sau khi từng BCC** → so BCC với defaults.
9. **Ticket hẹn snooze ĐÚNG hôm nay bị digest bỏ qua** → so sánh strict (`>` thay `>=`).
10. **Mục 2 digest lệch đồng hồ chọn/hiển thị** → cả hai cùng tính từ ngày giao.

---

# ĐỢT 4 — Đơn 15 (3/7/2026): Auto-reply theo To/Cc ✉️

## Luật mới (3 trường hợp chốt với anh Thuận)
Ticket vẫn tạo cho MỌI mailbox nhận được mail (To hay Cc đều tạo — không đổi).
**Auto-reply chỉ bắn khi mailbox của project nằm trong dòng To:**
1. To cả cnb + hris → 2 ticket, **cả 2 auto-reply** ✔ (như cũ)
2. To cnb, Cc hris → 2 ticket, **chỉ cnb auto-reply** (hris im lặng — trước đây cả 2 đều reply)
3. To người khác, Cc cnb/hris → ticket vẫn tạo, **không ai auto-reply**
- Áp cho cả 3 đường: intake mới, release mail-bomb (reprocess), và **rescue junk**
  (cứu 1 ticket cc-only cũng KHÔNG bắn ack muộn).
- Audit `ticket.created_from_email` thêm cờ `mailboxInTo` để soi vì sao không có ack.
- Test: IT-ACK-004 mới + IT-ACK-001→003, IT-JUNK 3/3 pass.

## Sửa flake hạ tầng test (root-cause sau 1 ngày "GreenMail lúc được lúc không")
GreenMail có timeout khởi động NỘI BỘ 2000ms/server — máy bận là smtps (load keystore
SSL) trễ hơn 2s → thread main chết → API :8080 không lên → testcontainers báo
"Port 8080 not bound" gây hiểu nhầm là Docker lỗi. Fix: `-Dgreenmail.startup.timeout=30000`
ở cả helper test + docker-compose.yml + docker-compose.e2e.yml.

---

## Trình tự deploy đề xuất (khi bạn gật đầu)
```bash
docker compose -f docker-compose.prod.yml --env-file .env build api worker web
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate api worker
# đợi api healthy (migrate 0012 tự chạy trước api)
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate web   # LUÔN sau api (nginx cache IP)
# chạy lệnh UPDATE template (Mục 4)
```
Rollback: build lại từ commit trước (migration 0012 là data-only, không phá schema; muốn
hoàn tác chỉ cần chấp nhận mọi participant active — không có mất mát dữ liệu).
</content>
