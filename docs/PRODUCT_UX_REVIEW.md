# Product & UX review — N2 Study Journal

Ngày đánh giá: 2026-08-18  
Phạm vi: dashboard, lesson/quiz, trình đọc sách, gia sư, mini-test, thi thử, profile và pet; desktop + mobile; code + E2E + production đã đăng nhập.

## Kết luận

Sản phẩm đã có lõi học N2 đáng tin cậy và khác biệt: nội dung sách thật, typography editorial, 5 kỹ năng, SRS, AI tutor, thi thử và dữ liệu tiến độ cùng nằm trong một ứng dụng. Bản nâng cấp này đã khép vòng lặp quan trọng nhất:

> Học bài → ghi lỗi sai → lên lịch ôn → gia sư dùng đúng điểm yếu → mini-test → cập nhật JLPT readiness.

Điểm nâng cấp có tác động lớn nhất tiếp theo không phải thêm một màn hình mới, mà là biến dashboard và pet thành một “next-best-action coach”: mỗi lần mở app chỉ cần chỉ ra đúng một việc nên làm tiếp theo và lý do.

## Điểm audit

| Hạng mục | Điểm | Nhận xét |
|---|---:|---|
| Accessibility | 18/20 | Có focus-visible, touch target, reduced motion, semantic heading/progress và không có lỗi axe serious/critical. Modal vẫn cần focus trap hoàn chỉnh. |
| Responsive | 18/20 | Mobile 375 px không tràn ngang; lesson, learning loop và mini-test co tốt. Bottom nav + pet + nội dung cố định vẫn cần kiểm tra thêm trên màn hình rất thấp. |
| Performance | 17/20 | Curriculum render lười theo tuần, ảnh sách lazy/decoding async và strip dùng content-visibility. Dashboard “Tất cả” vẫn tạo một trang dọc dài. |
| Visual system | 17/20 | Hệ typography-first, giấy ấm/mực/vermillion và màu kỹ năng nhất quán. Một số khu vực có mật độ card/đường viền cao hơn tinh thần editorial. |
| UX & information architecture | 14/20 | Luồng học mới rõ và readiness có bằng chứng. Tuy nhiên dashboard vẫn trộn “việc hôm nay” với toàn bộ 233 bài, khiến CTA chính mất ưu thế sau vùng đầu trang. |
| **Tổng** | **84/100** | Nền tảng tốt; ưu tiên tiếp theo là giảm tải nhận thức và làm pet có chức năng học thật. |

## Phát hiện tích cực

- Nội dung Nhật–Việt có thứ bậc rõ, furigana có thể tắt và các nút phát âm/giải thích nằm sát nội dung.
- “Hôm nay học gì?” đã cân bằng giữa bài mới, lỗi đến hạn và readiness theo 5 kỹ năng.
- Trình đọc mới là một dải liên tục duy nhất nhưng vẫn giữ ảnh riêng để tải lười, tránh một canvas khổng lồ gây tốn RAM.
- Mini-test chỉ dùng câu người học từng sai; kết quả quay lại cùng SRS và readiness thay vì tạo một điểm số rời rạc.
- Gia sư nhận đúng prompt, đáp án, số lần sai và trạng thái đến hạn; không cần suy đoán điểm yếu từ chat.
- Bắt buộc Google login, CSP chặt, nội dung thi/đáp án được bảo vệ phía server và kiểm thử E2E/a11y đã có nền tốt.

## Vấn đề nên ưu tiên

### P1 — Dashboard cần “Today mode” thật sự

Hiện vùng đầu trang tốt, nhưng phía dưới vẫn là 5 danh mục × nhiều tuần; ở chế độ “Tất cả”, nhiều tuần đầu được mở khiến người học phải cuộn qua hàng chục card. Nên mặc định chỉ hiển thị:

1. Một CTA chính: ôn lỗi / mini-test / bài mới tốt nhất.
2. Kế hoạch tối đa 3 việc trong ngày.
3. Năm kỹ năng dưới dạng tóm tắt; “Xem toàn bộ giáo trình” là lớp thứ hai.

Kỳ vọng: giảm thời gian từ mở app đến bắt đầu học và tăng tỷ lệ hoàn thành kế hoạch ngày.

### P1 — Đồng bộ sổ lỗi/SRS đa thiết bị

Tiến độ bài đã đồng bộ qua tài khoản, nhưng hồ sơ lỗi và lịch ôn vẫn là cache theo trình duyệt. Vì login là bắt buộc, người dùng sẽ kỳ vọng điểm yếu và lịch ôn đi theo tài khoản. Nên thêm bảng `learning_reviews` với RLS theo chủ sở hữu, merge theo `last_reviewed_at` và hàng đợi offline.

### P1 — Hiệu chỉnh readiness bằng độ tin cậy

Readiness hiện giải thích số bài, lượt ôn và đề thi dùng làm bằng chứng, nhưng trọng số vẫn là heuristic. Nên thêm:

- confidence thấp/vừa/cao;
- ngưỡng bằng chứng tối thiểu theo kỹ năng;
- section score từ đề thi (không dùng một điểm tổng cho mọi kỹ năng);
- xu hướng 7/30 ngày và ngày dự thi mục tiêu.

### P2 — Lesson cần mục lục/progress cục bộ

Bài Hán tự/đọc có thể rất dài. Nên có thanh nhỏ sticky: “Nội dung · Luyện tập · Gia sư”, kèm tiến độ câu đã làm. Sau câu sai, CTA “Ghi lỗi → hỏi gia sư” nên xuất hiện ngay tại câu thay vì chỉ ở cuối bài.

### P2 — Hoàn thiện modal và hành vi bàn phím

Trình đọc đã trả focus về nút mở và hỗ trợ Escape, nhưng nên thêm focus trap, khóa scroll nền và đặt `inert` cho nội dung phía sau. Trên mobile nên dùng full-screen sheet thay vì card trong overlay.

### P2 — Giảm cạnh tranh giữa bottom nav, pet và CTA

Bottom nav có 5 mục, pet nổi ở góc và một số trang có footer action; trên màn hình thấp ba lớp này dễ cạnh tranh. Nên cho pet tự né vùng CTA, thu nhỏ khi scroll và mở một panel thay vì bubble bay ngang.

### P3 — Dọn copy và dữ liệu hiển thị

Một số tiêu đề/meaning nguồn còn trộn tiếng Anh với ngôn ngữ khác hoặc dùng nhãn “Học/Đánh dấu” chưa hoàn toàn thống nhất. Nên có lint dữ liệu ngôn ngữ và glossary copy cho toàn app.

## Đề xuất nâng cấp pet

### Ý tưởng 10×: Pet là “coach cho bước tiếp theo”

Khi bấm pet, mở panel nhỏ chỉ có:

- trạng thái học hôm nay;
- một nhiệm vụ tốt nhất lấy từ learning engine;
- lý do: “2 lỗi ngữ pháp đang đến hạn”;
- một CTA: “Ôn 3 phút”.

Như vậy pet trở thành giao diện cảm xúc của learning loop, không chỉ là emoji đi theo streak.

### Roadmap ưu tiên

| Ưu tiên | Nâng cấp | Impact | Confidence | Effort | Ghi chú |
|---|---|---:|---:|---:|---|
| 1 | Daily quest theo kỹ năng yếu nhất | 9 | 9 | 3 | Dùng ngay daily plan + weakness profile hiện có. |
| 2 | Cảm xúc theo trạng thái học | 8 | 9 | 3 | Chờ ôn, tập trung, tự hào, nghỉ ngơi; không dùng buồn/ốm để gây guilt. |
| 3 | Tiến hóa theo mastery | 8 | 8 | 5 | 3 stage dựa trên lỗi đã làm chủ và độ cân bằng 5 kỹ năng, không chỉ streak. |
| 4 | Phần thưởng mỹ phẩm/phòng học | 6 | 7 | 6 | Mở khóa bằng milestone; không gacha, không pay-to-win. |
| 5 | Nhật ký kỷ niệm | 5 | 7 | 4 | Lưu khoảnh khắc: lần đầu hoàn thành tuần, sửa được lỗi lặp, mock exam mới. |
| 6 | Âm thanh/voice pet tùy chọn | 3 | 6 | 5 | Tắt mặc định; luôn tôn trọng reduced motion và mute. |

### Trạng thái pet nên map với learning loop

| Tín hiệu | Phản ứng pet | CTA |
|---|---|---|
| Có lỗi đến hạn | Mang “thẻ lỗi”, nhắc nhẹ một lần | Ôn ngay |
| Vừa sửa đúng lỗi lặp | Đóng dấu đỏ / ăn mừng ngắn | Làm câu tiếp |
| Mini-test hoàn tất | Hiện readiness delta | Xem tiến độ |
| Không có việc đến hạn | Nghỉ/đọc sách, không phạt mất streak | Học bài mới |
| Kỹ năng lệch | Chọn đạo cụ theo kỹ năng yếu | Nhiệm vụ cân bằng |

### Anti-goals

- Không để pet đói, ốm, bỏ đi hoặc mất cấp vì người dùng nghỉ.
- Không biến streak thành điều kiện duy nhất để tiến hóa.
- Không thêm tiền ảo/gacha trước khi learning loop chứng minh giá trị.
- Không để animation che nội dung, CTA hoặc bottom nav.

## Chỉ số nên đo

- Tỷ lệ hoàn tất vòng lặp: có lỗi → ôn trong 48 giờ → hoàn thành mini-test.
- Tỷ lệ xử lý lỗi đến hạn mỗi ngày.
- Thời gian từ mở app đến bắt đầu hành động học đầu tiên.
- Week-1 → Week-2 retention và số ngày học hữu ích, không chỉ streak.
- Tỷ lệ click daily quest của pet, tỷ lệ ẩn pet và tỷ lệ bật reduced motion.
- Readiness evidence coverage theo từng kỹ năng.

## Thứ tự triển khai đề xuất

1. Today mode + một CTA chính.
2. Đồng bộ `learning_reviews` đa thiết bị.
3. Pet daily quest + trạng thái cảm xúc theo learning loop.
4. Readiness confidence và section score.
5. Lesson sticky outline/progress.
6. Pet evolution/cosmetics và nhật ký kỷ niệm.
