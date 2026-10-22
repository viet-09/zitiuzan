# Cài N2 lên iPhone (không cần App Store)

N2 là PWA: website cài được lên màn hình chính, mở toàn màn hình và không cần gia hạn chữ ký ứng dụng sau mỗi 7 ngày. Giữ cùng một website/ứng dụng, tài khoản Google và dữ liệu đồng bộ hiện tại.

## Cài trên iPhone

1. Dùng **Safari** mở `https://zitiuzan.vercel.app/` trên iPhone.
2. Nhấn **Chia sẻ** (hình vuông có mũi tên) → **Thêm vào Màn hình chính**.
3. Nếu có tùy chọn **Mở dưới dạng ứng dụng web (Open as Web App)**, hãy bật lên.
4. Chọn **Thêm**. Biểu tượng **N2** sẽ xuất hiện trên màn hình chính.
5. Mở **N2** từ màn hình chính và đăng nhập Google nếu được yêu cầu.

**Lưu ý:** Đây là PWA chứ không phải ứng dụng native `.ipa`. Việc đăng nhập Google và đồng bộ yêu cầu internet; nội dung từng mở có thể được cache để xem lúc mất mạng, nhưng các tính năng cần máy chủ (AI, đồng bộ, tài khoản, thi thử online) không thể chạy offline. iOS có thể xóa cache khi thiếu dung lượng. Chưa xác minh thực tế luồng đăng nhập OAuth trong chế độ standalone trên iPhone; nếu bị chuyển sang Safari và không giữ đăng nhập, cần kiểm tra trực tiếp trên thiết bị trước khi coi là hoàn tất.

## Phát triển

Từ thư mục gốc dự án:

```powershell
npm run build:icons # chỉ cần khi thay SVG gốc
npm run check
npm run test:e2e
python -m http.server 8000 --bind 127.0.0.1
```

Mở `http://127.0.0.1:8000/` trên Windows để phát triển. iPhone phải truy cập bằng HTTPS hợp lệ mới đăng ký được service worker (mở HTTP nội mạng sẽ không cho đầy đủ tính năng PWA).

Nâng phiên bản cache khi thay đổi bản phát hành bằng `node scripts/bump-version.mjs`, rồi kiểm tra `npm run check`.
