# Workflow Map — Ghi chú Slide (copy-paste)

> Ảnh: `docs/workflow-map.svg` (vector — chèn thẳng PowerPoint/Google Slides) và
> `docs/workflow-map.png` (3840×2160, cho tool không import SVG).

---

## 📭 Phân khu 1 — Cổng tiếp nhận (Inbound Source)
Hệ thống tiếp nhận **song song** luồng email thô từ **2 hộp thư Gmail độc lập**: `hris` và `cnb`.
Dữ liệu được đẩy liên tục theo **chu kỳ quét IMAP mỗi 60 giây (NFR3)**.

## 🌪️ Phân khu 2 — Phễu lọc kỹ thuật 4 tầng (Core Ingest Pipeline)
Luồng email **bắt buộc** đi qua trục dọc 4 tầng kiểm tra trước khi được phép thành ticket:

- **Tầng 1 — DEDUPE (chống gửi trùng):** kiểm khóa composite `(message_id, mailbox)`. Trùng (lỗi
  mạng / bấm gửi 2 lần) → mail thứ 2 **bị nuốt ngay tại cửa ngõ**, tránh ticket rác.
- **Tầng 2 — BLOCKLIST & MAIL-BOMB:** kiểm danh sách đen + giới hạn tần suất gửi trong project.
  Spam dồn dập (mail-bomb) → **tự ngắt luồng**.
- **Tầng 3 — JUNK (phễu con bóc tách thư máy, 4 màng lọc header):**
  1. **Auto-Submitted** (RFC 3834)
  2. **Precedence** (bulk / auto / list)
  3. **X-Autoreply** (header tự chế)
  4. **List-Id / List-Unsubscribe** (dấu hiệu marketing)
  🔴 Dính **bất kỳ 1** màng → bẻ hướng, **rơi thẳng xuống Thùng JUNK** (vd: mail báo nghỉ phép tự
  động). Giữ bể ticket luôn sạch.
- **Tầng 4 — CLASSIFY (phân loại tự động):** quét so khớp **từ khóa không dấu** → gắn nhãn phân mục
  (Payroll · Insurance · Leave…). Không khớp → nhóm **"Khác"**.

## 🏊 Phân khu 3 — Bể Ticket chung & quyền xử lý (Pool · Claim · Assign)
Sau 4 tầng lọc, email **"người thật gõ tay"** an toàn rơi xuống **THE POOL**. Vận hành theo 2 trục:
- **CLAIM (nhận việc):** **Member + Team Lead** trong nhóm chủ động vào Pool kéo ticket về danh sách
  cá nhân.
- **ASSIGN (giao việc):** **chỉ Team Lead** điều phối, giao thẳng ticket từ Pool xuống Member dưới
  quyền.

## 👑 Phân khu 4 — Trục quản trị tách biệt (SSA vs Admin)
Tách hoàn toàn khỏi luồng xử lý để an toàn thông tin C&B:
- **SSA (Super System Admin):** cấp cao nhất, quyền **xuyên suốt** — cấu hình đồng thời **cả 2
  project** (HRIS & C&B).
- **Admin dự án:** **phân mảnh độc lập** theo từng project. Admin HRIS ⟂ Admin C&B (không đụng cấu
  hình của nhau). Admin **chỉ**: tạo · sửa · khóa · chuyển Pool — **KHÔNG trả lời mail chuyên môn**,
  chỉ điều phối vòng đời + cấu hình toàn bộ tham số project của mình.

> ⏱ **Scheduler tick mỗi 60 giây:** digest · nhắc quá hạn · snooze tới hạn · repair đính kèm ·
> worker heartbeat.

---

## Bản Mermaid (chỉnh chữ nhanh — render ở mermaid.live)
```mermaid
flowchart TB
  subgraph Z1["① Cổng tiếp nhận — IMAP 60s"]
    H[Gmail HRIS]:::mail
    C["Gmail C&B"]:::mail
  end
  H --> D1
  C --> D1

  subgraph Z2["② Phễu lọc kỹ thuật 4 tầng"]
    direction TB
    D1["TẦNG 1 · DEDUPE<br/>khóa (message_id, mailbox)"]:::stage
    D2["TẦNG 2 · BLOCKLIST & MAIL-BOMB<br/>danh sách đen + giới hạn tần suất"]:::stage
    D3["TẦNG 3 · JUNK — 4 màng lọc header<br/>Auto-Submitted · Precedence · X-Autoreply · List-Id/Unsub"]:::junk
    D4["TẦNG 4 · CLASSIFY<br/>từ khóa không dấu → nhãn / Khác"]:::ok
    D1 --> D2 --> D3 --> D4
  end

  D1 -. trùng .-> X1["✕ Nuốt mail trùng"]:::rej
  D2 -. spam .-> X2["✕ Chặn / ngắt luồng"]:::rej
  D3 -. dính 1 màng .-> X3["🗑 THÙNG JUNK<br/>vd: mail nghỉ phép tự động"]:::rej

  D4 -->|email người thật| POOL
  subgraph Z3["③ Pool · Claim · Assign"]
    POOL["🏊 THE POOL — bể ticket chung"]:::pool
    POOL -->|"Member + Team Lead kéo về"| CLAIM["CLAIM · Nhận việc"]:::ok
    POOL -->|"chỉ Team Lead giao xuống"| ASSIGN["ASSIGN · Giao việc"]:::stage
  end

  subgraph Z4["④ Quản trị tách biệt"]
    SSA["👑 SSA — cấu hình cả 2 project"]:::gov
    SSA --> AH["Admin HRIS"]:::gov
    SSA --> AC["Admin C&B"]:::gov
  end
  AH -. "tạo/sửa/khóa/chuyển Pool" .-> POOL
  AC -. "tạo/sửa/khóa/chuyển Pool" .-> POOL

  classDef mail fill:#fff,stroke:#1F3A5F,stroke-width:2px;
  classDef stage fill:#fff,stroke:#1F3A5F,stroke-width:2px;
  classDef junk fill:#FFF7F6,stroke:#D14343,stroke-width:2px;
  classDef ok fill:#fff,stroke:#1F9D6B,stroke-width:2px;
  classDef rej fill:#FCEBEA,stroke:#D14343,stroke-width:2px;
  classDef pool fill:#1F3A5F,color:#fff,stroke:#1F3A5F;
  classDef gov fill:#FFFBEF,stroke:#B8860B,stroke-width:2px;
```
</content>
