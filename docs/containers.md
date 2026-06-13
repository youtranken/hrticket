# Các container & workload (docker compose)

> Vì sao 5 container, mỗi cái làm gì, và vì sao tách ra như vậy.
> Định nghĩa thật nằm ở `docker-compose.yml`; file này giải thích **lý do**.

## Sơ đồ

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  web        │   │  api        │   │  worker     │
│ (nginx)     │   │ (NestJS)    │   │ (NestJS)    │
│ giao diện   │──▶│ xử lý request│  │ chạy ngầm   │
│ React tĩnh  │   │ login,/me...│   │ (mail loop) │
│  :8080      │   │  :3000      │   │ không cổng  │
└─────────────┘   └──────┬──────┘   └──────┬──────┘
                         │                 │
                  ┌──────▼─────────────────▼──────┐
                  │  postgres  (CSDL :5432)        │
                  │  lưu user, ticket, session...  │
                  └────────────────────────────────┘
                  ┌────────────────────────────────┐
                  │  mailpit  (hộp thư giả :8025)   │
                  │  bắt email khi dev/test         │
                  └────────────────────────────────┘
```

## Bảng nhiệm vụ

| Container | Việc gì | Cổng | Bắt buộc? |
|---|---|---|---|
| **postgres** | CSDL — lưu *mọi thứ*: user, ticket, message, session, audit… | 5432 | ✅ Lõi |
| **api** | "Bộ não" — nhận request từ browser, xử lý login / quyền / dữ liệu (HTTP) | 3000 | ✅ Lõi |
| **web** | nginx phục vụ giao diện React đã build (HTML/JS/CSS tĩnh) + proxy `/api` sang api | 8080 | ✅ Lõi |
| **worker** | Chạy **ngầm**, không ai gọi — sẽ poll email IMAP, gửi outbox, nhắc hẹn (Epic 2/3/6). Hiện chỉ giữ tiến trình sống | — | ✅ (trái tim app) |
| **mailpit** | Hộp thư **giả** cho dev — bắt email OTP/reset/cảnh báo thay vì gửi thật ra ngoài. UI xem mail ở `:8025` | 1025 / 8025 | ⚙️ chỉ dev/test |

## Vì sao api và worker tách riêng dù **cùng codebase**?

Đây là điểm thiết kế quan trọng nhất:

- **api** phải trả lời **nhanh** cho người dùng (bấm login → có ngay). Nó **không được** bận đi đọc email mỗi 5 phút.
- **worker** làm việc **nặng / chậm / lặp lại** ở chế độ ngầm (đọc hộp mail qua IMAP, gửi mail hàng loạt qua outbox, chạy scheduler nhắc hẹn).

Nếu nhét chung vào api, một lần kẹt mail sẽ làm **cả trang web đơ**. Tách ra:
api lo người dùng, worker lo việc ngầm — **hỏng cái nào không kéo cái kia sập**.

Cả hai dùng chung 1 image (`apps/api/Dockerfile`), chỉ khác lệnh chạy:
`node dist/main.js` (api, có HTTP) vs `node dist/worker.js` (worker, không HTTP listener).

## Lõi vs tiện ích

- **Production** chỉ cần 4: `postgres + api + web + worker`. **Bỏ mailpit** (production gửi mail thật).
- **Dev/test** thêm `mailpit` để khỏi spam mail thật ra ngoài → thành 5.

## Một câu

CSDL · não · giao diện · việc-ngầm · hộp-thư-giả — 5 phần việc bản chất khác nhau,
tách process để cô lập lỗi và để api luôn nhanh.

> Build prod NGAY TỪ ĐẦU (`NODE_ENV=production`); dev nhanh thì `pnpm dev`, KHÔNG
> chạy ts-node/watch trong image. Xem cạm bẫy prod-build ở `CLAUDE.md`.
