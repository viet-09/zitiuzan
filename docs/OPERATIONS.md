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
