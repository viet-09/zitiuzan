# Vận hành và triển khai

## Kiểm tra trước release

```powershell
npm ci
npm run build:vendor
npm run check
npm run test:coverage
npm run test:e2e
```

Yêu cầu: Node.js 24+, Python 3 để phục vụ static site trong E2E, Chrome cài trên máy phát triển. CI dùng Chromium do Playwright quản lý.

## Supabase

Biến bí mật nằm trong `.env.local` và không được commit:

- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PAT`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`

Áp dụng migration/schema rồi xác minh:

```powershell
node scripts/apply-schema.mjs
node scripts/verify-schema.mjs
node scripts/link-and-deploy.mjs
```

Migration phát hành nằm trong `supabase/migrations/`. Browser chỉ có quyền đọc trực tiếp tiến độ; thay đổi hoàn thành bài và thời gian học đi qua RPC đã xác thực.

## Audio nghe (GitHub Release)

Audio bài nghe và audio đề thi nằm trên GitHub Release `audio-v1` của repo, không nằm trong git tree và không còn nằm trong Supabase Storage. Client tự dựng URL (`js/audio-source.js`) nên không cần signed URL hay Edge Function nào.

Cần thêm vào `.env.local`:

- `GITHUB_TOKEN` — classic PAT có scope `repo`, hoặc fine-grained token có `Contents: read and write` trên repo này.

```powershell
node scripts/upload-audio-github.mjs --dry-run
node scripts/upload-audio-github.mjs
node scripts/upload-audio-github.mjs --bitrate=64k   # nén mono trước khi up
```

Script tự tạo release nếu chưa có, và ghi đè asset trùng tên nên chạy lại an toàn. Sitting nào không tìm được file nguồn sẽ được cảnh báo và bỏ qua — app hiển thị "Chưa có file nghe cho đề này".

CSP đã cho phép `https://github.com` và `https://objects.githubusercontent.com` trong `media-src` (cả `index.html` và `vercel.json`) — release URL redirect sang host thứ hai.

## Vercel

Triển khai production từ thư mục gốc:

```powershell
npx vercel --prod
```

Sau deploy, kiểm tra `https://zitiuzan.vercel.app/`: CSP, manifest, service worker, cổng đăng nhập Google bắt buộc, hoàn thành bài, leaderboard, audio và Edge Functions.

## Rollback

1. Redeploy commit production trước đó trên Vercel.
2. Chạy `supabase/rollback/20260818_comprehensive_learning_upgrade.sql` để khôi phục quyền tương thích cho client cũ.
3. Không xóa `curriculum_lessons` hoặc `study_sessions`; rollback này không làm mất dữ liệu.
4. Xác minh đăng nhập, hoàn thành/bỏ hoàn thành một bài, thời gian học và leaderboard.

Sau khi sự cố được xử lý, áp dụng lại migration hiện tại trước khi đưa client mới lên production.
