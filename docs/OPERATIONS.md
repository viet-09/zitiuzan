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

## Mục "Ôn lại" trong bài học

Câu ôn thêm do AI soạn từ nội dung từng bài, nằm dưới phần 練習. Sinh bởi Edge Function `lesson-review-quiz` và lưu ở bảng **`lesson_review_quiz` — dùng chung cho mọi học viên**, không cache theo user: câu hỏi thuộc về bài học, mà quota Gemini free chỉ vài chục lượt/ngày nên cache theo user sẽ nhân số lần gọi lên bằng số người dùng.

Client chỉ được `select`; chỉ Edge Function ghi (service role), nên không ai chèn bậy được nội dung mà cả lớp cùng học.

Luật lọc/chống trùng nằm ở `supabase/functions/_shared/lesson-review-rules.js` — file JS thuần, Deno bundle cho function và Node import trong `tests/lesson-review.test.mjs`, nên test chạy đúng logic server chạy.

Muốn soạn lại một bài: xoá dòng tương ứng trong `lesson_review_quiz`, lần mở bài kế tiếp sẽ sinh lại.

## Âm Hán Việt

`data/kanji-hanviet.json` — âm Hán Việt của 665/683 kanji trong giáo trình, hiện dưới mỗi thẻ kanji và trong tờ luyện viết.

Không dùng thẳng Unihan `kVietnamese` được: trường đó **trộn âm Nôm** (寄→"gửi", 冷→"lạnh", 未→"mùi", 鋭→"nhọn") và thiếu cả những chữ rất thường gặp (愛, 米). Nên script chạy **hai lượt AI diễn đạt khác nhau**, và chỉ giữ âm nào (a) hai lượt khớp nhau, hoặc (b) một lượt khớp Unihan. 18 chữ còn tranh chấp bị bỏ trống thay vì đoán — trong đó 込 và 畑 là kokuji, vốn không có âm Hán Việt.

```powershell
node scripts/build-kanji-hanviet.mjs --unihan-only   # không gọi AI
node scripts/build-kanji-hanviet.mjs                 # dựng lại đầy đủ
```

Tốn ~12 lượt Gemini; hết quota `flash` thì script tự chuyển sang `flash-lite`.

## Dữ liệu nét chữ kanji

`data/kanji-strokes.json` chứa đường nét theo đúng thứ tự viết cho 683 kanji của giáo trình, dùng cho bảng luyện viết (`js/kanji-writing.js` + `js/kanji-stroke-match.js`). File được tải lười khi mở bảng luyện viết, không nằm trong app shell.

Nguồn: **KanjiVG** (https://kanjivg.tagaini.net), Copyright (C) Ulrich Apel, giấy phép **CC BY-SA 3.0**. Đường nét được trích nguyên văn nên vẫn thuộc giấy phép đó — thông tin ghi công nằm trong chính file JSON (khối `license`).

Tạo lại khi giáo trình thêm kanji mới:

```powershell
node scripts/build-kanji-strokes.mjs
node scripts/build-kanji-strokes.mjs --refetch   # bỏ qua cache tạm
```

Script cảnh báo nếu số nét trong `data/book/kanji.json` lệch với KanjiVG — lệch nghĩa là một trong hai nguồn sai, và bảng luyện viết sẽ đòi số nét mà thẻ kanji phủ nhận.

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
