# Sprite sheet bằng Codex + chuyển động mượt và action animation

Ngày: 2026-11-02 · Trạng thái: chủ bỏ qua phần hỏi đáp ("ok làm đi"). Mọi quyết định dưới đây là **lựa chọn của Claude**, chủ có thể sửa ở bước duyệt kế hoạch.

## Mục đích

Nhân vật trên overlay LIVE (`live/overlay.html`) và bản web (`index.html`) hiện đang:
- di chuyển theo đường gãy khúc, tốc độ đều rồi dừng đột ngột;
- chân trượt trên sàn vì nhịp frame không khớp với quãng đường đi;
- đi ngang bằng cách lật frame "đi quay lưng";
- biến mất ngay khi rời chỗ;
- chỉ có 8 frame cho 3 skin (man, woman, granny). Monk, nun, child chỉ có ảnh tĩnh.

Mục tiêu: nhân vật trông sống động hơn trên live, cụ thể là đi mượt, có hành động phản hồi khi người xem bình luận, tặng quà hoặc đến thời kinh. Đây là nền cho tính năng "Ngọn Đèn Tâm" về sau.

## Mục tiêu

1. **Pipeline tạo asset bằng Codex CLI**
   - Dùng `codex exec` có bật `image_generation`. Đưa ảnh tham chiếu `assets/c_*.png` và `assets/anim_*.png` vào bằng `-i` để giữ đúng style.
   - Đầu ra là sprite sheet nền trong suốt, lưới frame cố định, đủ 6 skin: man, woman, granny, monk, nun, child. Skin `master` dùng lại monk.
   - Prompt và script nằm trong repo để chạy lại được.
2. **Bộ action** cho mỗi skin, mỗi action là một hàng trong sheet:
   - `walk_back`: đi vào, quay lưng, lặp vòng;
   - `walk_side`: đi ngang vào hàng, lặp vòng, lật frame cho hướng ngược lại;
   - `sit_down`: ngồi xuống bồ đoàn;
   - `idle`: ngồi niệm, chắp tay, thở nhẹ, lặp vòng;
   - `bow`: lạy, khi bình luận hoặc đến thời kinh;
   - `thank`: chắp tay cảm tạ, khi tặng quà;
   - `stand_up` rồi `walk_front`: đứng dậy và đi ra, khi bị nhường chỗ hoặc bị xoá.
3. **Chuyển động mượt**
   - Nhân vật đi theo đường cong qua các điểm cửa → lối giữa → đầu hàng → chỗ ngồi, có tăng tốc khi bắt đầu và giảm tốc khi dừng.
   - Tốc độ theo độ dài cung, tỉ lệ với độ sâu phối cảnh.
   - Nhịp frame tính theo quãng đường đã đi để chân không trượt.
   - Hướng sprite chọn theo vector vận tốc: đi lên là `walk_back`, đi ngang là `walk_side`, đi xuống là `walk_front`.
   - Khi lưới chỗ mở rộng, nhân vật lướt sang chỗ mới có easing, không nhảy.
4. **Máy trạng thái action có hàng đợi**
   - Sự kiện kích hoạt action một lần (`bow`, `thank`), xong thì quay về `idle`.
   - Thời kinh làm cả chánh điện lạy lần lượt như một làn sóng, từ hàng trước ra hàng sau.
5. **Code dùng chung.** Logic sprite, animator và đường đi tách thành `assets/js/sprites.js`, cả `overlay.html` lẫn `index.html` đều import. Server hiện đã phục vụ `/assets/*.js`, và Cloudflare Pages cũng phục vụ được.
6. **Manifest dữ liệu** `assets/sprites/manifest.json`, khai báo cho từng skin:
   - kích thước frame;
   - với mỗi action: hàng, số frame, fps hoặc số px mỗi frame, có lặp hay không;
   - điểm neo chân (anchor), dùng để khớp frame ngồi với kích thước hiện tại.

## Không làm (non-goals)

- Không đổi sang WebGL, PixiJS hay bất kỳ framework nào. Giữ Canvas 2D thuần, không bước build.
- Không làm "Ngọn Đèn Tâm". Đó là tính năng riêng.
- Không đổi giao thức WebSocket. Sự kiện `leave`, `chat`, `gift`, `chant` đã đủ. Riêng action rời đi phải chạy hết ở phía client trước khi xoá nhân vật.

## Điều kiện thất bại (anti-goals)

- Nhân vật mỗi frame một kiểu (khác khuôn mặt, khác màu áo, khác tỉ lệ) do sinh ảnh không nhất quán. Thà ít frame mà đồng nhất.
- Frame lệch điểm neo, khiến nhân vật rung lắc hoặc nhảy khi đổi frame.
- FPS tụt dưới 50 khi có 100 người ngồi trên máy phát.
- Asset quá nặng: mỗi sheet nên dưới khoảng 600 KB, cân nhắc WebP có fallback PNG.
- Bản web hoặc overlay hỏng khi thiếu sheet. Phải fallback về ảnh tĩnh như hiện tại.

## Ràng buộc

- Ảnh do model sinh không bao giờ khớp lưới hoàn hảo, nên bắt buộc có bước hậu kỳ:
  - cắt từng frame;
  - căn điểm neo theo bàn chân hoặc đáy bồ đoàn;
  - chuẩn hoá chiều cao;
  - xuất ra lưới đều.
  - Tool hậu kỳ chỉ dùng lúc dev, nằm trong `tools/sprites/` với `package.json` riêng (ví dụ dùng `sharp`), không thêm phụ thuộc vào `live/`.
- Nên sinh từng action, hoặc từng frame dùng frame trước làm tham chiếu, rồi mới ghép lại. Sinh cả sheet một lần dễ lệch style.
- Tôn trọng `prefers-reduced-motion`: tắt thở, tắt làn sóng lạy, giữ tối thiểu chuyển động.
- Giữ nguyên các biện pháp bảo mật hiện có: chữ vẽ bằng canvas hoặc `textContent`, danh sách trắng file tĩnh.

## Để builder tự quyết

- Kích thước frame và số frame cho từng action, trong giới hạn nhất quán và dung lượng ở trên.
- Loại đường cong: Catmull-Rom, Bézier, hay nhiều đoạn thẳng có easing.
- Codex sinh ảnh từng frame hay từng action. Chọn theo kết quả thử 1 skin trước.

## Cách kiểm tra

- Mở `http://localhost:3000/live/control.html`, đổ 15 / 64 / 100 người, bật bot nhịp nhanh, rồi xem overlay ở kích thước 1080×1920. Phải thấy:
  - đi mượt, không trượt chân;
  - lạy khi có bình luận, cảm tạ khi có quà;
  - đứng dậy và đi ra khi bị nhường chỗ;
  - làn sóng lạy khi bấm "Đọc kinh định kỳ ngay".
- Đo FPS khi có 100 người.
- Chụp màn hình trước và sau để so.
- Mở `index.html` bằng một static server bất kỳ, vào chánh điện và kiểm tra lại các điểm trên.
