# Sprite sheet bằng Codex + chuyển động mượt + action animation — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Luật của chủ thắng mọi skill:** không `git commit` / merge / push khi chủ chưa bảo. Các bước "commit" của template bị bỏ. Chỉ có 2 điểm dừng: duyệt kế hoạch, và sau khi sinh thử skin `man` (Task 2).

**Goal:** Nhân vật trên overlay LIVE và bản web đi mượt theo đường cong, không trượt chân, có lạy / cảm tạ / đứng dậy đi ra, dùng sprite sheet 6 skin sinh bằng Codex.

**Architecture:** Một tool dev `tools/sprites/` (Node + `sharp`) gọi `codex exec` sinh từng action thành một dải ảnh, rồi hậu kỳ (tách frame, căn neo chân, chuẩn hoá chiều cao) thành `assets/sprites/<skin>.webp` + `manifest.json`. Một file runtime dùng chung `assets/js/sprites.js` (script thường, khai báo `window.CDSprites`) lo nạp sheet, đường đi Catmull-Rom, máy trạng thái action và vẽ. `overlay.html` và `index.html` giữ phần ghế, HUD, sự kiện riêng, chỉ gọi vào `CDSprites`.

**Tech Stack:** Canvas 2D thuần, không build. Node 24 (`node:test`), `sharp` 0.35.5 (chỉ trong `tools/sprites/`), Codex CLI 0.160.0 (`image_generation`), Playwright MCP để chụp màn hình và đo FPS.

**Spec:** `docs/superpowers/specs/2026-11-02-sprite-animation-design.md`

## Quyết định của Claude, cần chủ kiểm

| # | Quyết định | Lý do / hệ quả |
|---|---|---|
| Q1 | `assets/js/sprites.js` là **script thường** gắn `window.CDSprites`, nạp bằng `<script src>`, **không** dùng `type="module"` hay `import`. Khác chữ "import" trong spec. | Hook credit "Kent Juno" ghi đè `window.frame` / `window.tick`. Nếu chuyển trang sang module thì các hàm đó không còn là global, dòng credit mất mà không báo lỗi. Giữ script thường thì hook không phải đụng tới. |
| Q2 | **Ghế cố định**: người mới lấy đúng ghế trống, không dồn cả hàng khi có người rời. Chỉ xếp lại toàn bộ (có lướt easing) khi lưới đổi cỡ 24/36/64/100. Người đang rời **giữ ghế** cho tới khi bắt đầu đi ra (`exit`). Nếu ghế còn bị giữ thì người mới đi bộ vào, không hiện ngay tại chỗ. | Hiện tại `reseat()` gán ghế theo thứ tự, nên khi đủ 100 người, mỗi lượt rời/vào làm cả trăm người dịch một ghế, đúng lúc người rời còn đang đứng dậy. |
| Q3 | Người đang rời nằm trong danh sách riêng `leaving`, không tính vào số đếm, bảng Công Đức hay xếp ghế. Gói `state` (làm trống, kết nối lại) xoá ngay, không diễn. | Tránh pill hiện 101/100 và người đã rời vẫn nằm trên bảng. |
| Q4 | Sheet chỉ xuất **WebP có alpha**, không có PNG dự phòng. Thiếu hoặc lỗi sheet thì skin đó dùng ảnh tĩnh `c_*.png` như hiện nay. | Dải 8 frame PNG hiện tại đã ~355 KB, sheet 7 hàng bằng PNG sẽ vượt xa 600 KB. OBS / TikTok Studio / trình duyệt đều đọc được WebP. |
| Q5 | Bỏ hẳn đường vẽ dải cũ `anim_*.png` (`ANIM`, `hasAnim`). File vẫn giữ trong repo, dùng làm ảnh tham chiếu style cho Codex. | Có sheet mới cho cả 6 skin rồi thì dải cũ thừa. Fallback chỉ còn một nhánh là ảnh tĩnh. |
| Q6 | `stand_up` = `sit_down` phát ngược. Không sinh hàng riêng. | Bớt một lần sinh ảnh mỗi skin, và chắc chắn khớp với lúc ngồi xuống. |
| Q7 | `idle` = 1 frame ngồi + thở bằng code (như hiện nay). Không sinh nhiều frame thở. | Nhìn từ sau lưng, frame thở gần như không khác nhau, lại dễ lệch style (anti-goal số 1). Manifest vẫn cho phép nhiều frame nếu sau này muốn. |
| Q8 | Ô frame **192×240**, neo chân tại (96, 232). Mỗi sheet 7 hàng × tối đa 6 cột. Số frame: `walk_back` 6, `walk_side` 6, `walk_front` 6, `sit_down` 5, `idle` 1, `bow` 6 (phát xuôi, giữ, rồi ngược), `thank` 4 (xuôi, giữ, ngược). `master` dùng sheet `monk`. `child` cùng ô nhưng chuẩn hoá chiều cao ×0.8. | Trên sân khấu 1080×1920, người đứng cao nhất ~150 px, nên ô 240 px là đủ nét. Có thể đổi sau khi xem thử skin `man`. |
| Q9 | Codex sinh **mỗi action một ảnh** (một dải N frame), kèm ảnh tham chiếu `c_<skin>.png`, `anim_<skin>.png` (nếu có), và dải `walk_back` đã duyệt của chính skin đó. Nếu thử `man` thấy lệch trong dải thì mới thêm chế độ sinh từng frame. | Ít lượt sinh (7 lượt/skin). Spec để builder chọn theo kết quả thử. |
| Q10 | Đường đi: Catmull-Rom centripetal qua cửa → lối giữa → đầu hàng → ghế. Tốc độ theo quãng đường, có đoạn tăng tốc và giảm tốc. | Centripetal không tạo vòng xoắn hay vượt quá điểm, kể cả khi các điểm gần nhau. |
| Q11 | Ảnh gốc Codex (`tools/sprites/raw/`) **không commit** (thêm vào `.gitignore`). Chỉ commit sheet đã hậu kỳ. | Repo public, ảnh gốc vài MB mỗi tấm. Đổi lại: muốn build lại từ ảnh gốc thì phải giữ bản trên máy. |
| Q12 | `index.html` không có sự kiện đọc kinh nên **không có làn sóng lạy**. Nút "Rời" chạy hoạt cảnh đứng dậy, đi ra. | Đúng với những gì trang đó đang có. |
| Q13 | Thêm `?v=2` vào URL của `sprites.js` và `manifest.json`. | `_headers` cache `/assets/*` 7 ngày. Không có version thì runtime cũ có thể đi với manifest mới. |
| Q14 | `prefers-reduced-motion`: tắt thở, tắt làn sóng lạy. Vẫn đi bộ và lạy riêng lẻ, vì đó là phản hồi cho sự kiện. | Spec yêu cầu giữ chuyển động ở mức tối thiểu, không yêu cầu tắt hẳn. |

## Global Constraints

- Canvas 2D thuần, không WebGL/PixiJS/framework, không bước build cho trang.
- Không đổi giao thức WebSocket; dùng sẵn `join`, `leave`, `chat`, `gift`, `chant`, `skin`, `state`.
- `live/package.json` không thêm phụ thuộc nào; `sharp` chỉ nằm trong `tools/sprites/package.json`, ghim đúng `0.35.5`.
- Mỗi sheet ≤ 600 KB (build phải fail nếu vượt).
- FPS ≥ 50 khi có 100 người, đo ở overlay 1080×1920 trên trình duyệt có giao diện (headed).
- Thiếu sheet hoặc manifest thì không được hỏng trang; skin đó vẽ ảnh tĩnh `c_*.png` như hiện nay.
- Chữ vẫn vẽ bằng canvas hoặc `textContent`; không thêm đường dẫn tĩnh mới cho server (`/assets/js/*.js`, `/assets/sprites/*` đã nằm trong danh sách trắng).
- Không sửa khối IIFE "lantern ambience" ở `index.html:377-385` và `live/overlay.html:319-327`.
- Trao đổi với chủ bằng tiếng Việt. Không commit/merge/push khi chưa được bảo.
- Sinh ảnh tốn credit: chỉ skin `man` trước, dừng chờ chủ duyệt style.

## Review Focus

1. **Cùng id vào lại khi đang diễn rời đi** (bot tắt rồi bật nhanh): phải huỷ hoạt cảnh rời, người đó quay lại ghế mới, không có hai bản cùng id. Kiểm ở Task 5 Step 6 (tắt bot rồi bật lại ngay).
2. **Hướng sprite nháy giữa back/side trên khúc cua**: cần ngưỡng trễ (hysteresis), đổi hướng chỉ khi góc vượt ngưỡng ổn định. Test: `direction has hysteresis` (Task 4).
3. **Ghế đổi khi người còn đang đi** (lưới 24 → 36 lúc có người đang vào): đi tiếp từ vị trí hiện tại tới ghế mới, giữ nguyên tốc độ, không nhảy. Test: `retarget keeps position and speed` (Task 4).
4. **Tắt bot: 100 người cùng rời một lối**: dồn cục ở lối giữa. Mỗi người bắt đầu trễ ngẫu nhiên 0–1.5 s. Kiểm bằng mắt ở Task 7 (chụp màn hình lúc tắt bot).
5. **Một người spam bình luận**: hàng đợi action tối đa 2, action trùng với phần tử cuối hàng đợi thì bỏ. Test: `queue is capped and deduped` (Task 4).
6. *(phụ)* Đổi skin giữa lúc đi, kể cả sang skin không có sheet: không lỗi, skin không sheet thì nhảy thẳng vào ghế như hiện nay. Test: `step with null sheet snaps to seat` (Task 4).

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `tools/sprites/package.json` | `{"type":"module","private":true}`, dep `sharp: "0.35.5"`, scripts `gen`, `build`, `test` |
| `tools/sprites/prompts.json` | Đoạn mô tả style chung + mô tả từng action + số frame + tham số chuẩn hoá |
| `tools/sprites/gen.mjs` | `node gen.mjs <skin> <action>`: gọi `codex exec`, lấy ảnh mới nhất, chép vào `raw/<skin>/<action>.png` |
| `tools/sprites/build.mjs` | `node build.mjs <skin>`: ảnh gốc → `assets/sprites/<skin>.webp` + cập nhật manifest + `out/<skin>_check.png` |
| `tools/sprites/lib.mjs` | Hàm thuần của hậu kỳ (xử lý nền, tách frame, tìm neo, đặt vào ô), để test được |
| `tools/sprites/test/lib.test.mjs` | Test hậu kỳ bằng ảnh tổng hợp |
| `tools/sprites/test/runtime.test.mjs` | Test `assets/js/sprites.js` |
| `assets/sprites/manifest.json`, `assets/sprites/<skin>.webp` | Sản phẩm đã hậu kỳ (được commit) |
| `assets/js/sprites.js` | Runtime dùng chung, gắn `window.CDSprites` (≤ ~300 dòng) |
| `live/overlay.html`, `index.html` | Gọi `CDSprites`; ghế cố định, danh sách `leaving` |
| `.gitignore` | Thêm `tools/sprites/raw/`, `tools/sprites/out/` |

---

### Task 0: Baseline trước khi sửa

**Files:** chỉ đọc. Ảnh lưu ở `docs/superpowers/shots/before/` (không commit nếu chủ không bảo).

- [ ] **Step 1:** `cd live && npm install && npm start` (chạy nền).
- [ ] **Step 2:** Playwright MCP (headed), viewport 1080×1920, mở `http://localhost:3000/live/overlay.html`. Ở tab khác mở `control.html`, bấm "Đổ người mẫu 100", bật "Bot mô phỏng" nhịp nhanh. **Rồi chọn lại tab overlay (`browser_tabs`) trước mọi lần chụp hoặc đo FPS**, vì tab nền bị trình duyệt hãm rAF. Luật này áp dụng cho mọi Task bên dưới.
- [ ] **Step 3:** Chụp `overlay-100.png`. Đo FPS bằng `browser_evaluate`:
  ```js
  await new Promise(r=>{let n=0,t0=performance.now();(function f(t){n++; if(t-t0<5000) requestAnimationFrame(f); else r(n/((t-t0)/1000));})(t0)})
  ```
  Ghi con số vào báo cáo.
- [ ] **Step 4:** `python -m http.server 8080` ở gốc repo, mở `http://localhost:8080/index.html`, vào chánh điện, chụp `index.png`.

### Task 1: Tool sinh và hậu kỳ sprite

**Files:**
- Create: `tools/sprites/{package.json,prompts.json,gen.mjs,build.mjs,lib.mjs}`, `tools/sprites/test/lib.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces (`lib.mjs`, mọi ảnh là `{data: Uint8Array RGBA, width, height}`):
  - `keyBackground(img, tol = 40, soft = 60): img`. Nếu ảnh đã có pixel alpha < 255 ở cả 4 góc thì giữ nguyên. Nếu không, lấy màu trung vị của 4 góc làm nền. Pixel cách màu nền (khoảng cách RGB) ≤ `tol` thì alpha = 0. Pixel nằm trong khoảng `tol`..`tol+soft` thì alpha giảm tuyến tính, và trừ bớt phần màu nền khỏi RGB (despill), để viền không còn ánh hồng trên nền điện tối.
  - `splitFrames(img, n): {x0,x1}[]`. Chiếu theo cột (cột nào có alpha > 16 là có nội dung), gộp các khoảng trống < 4 px, lấy các dải. Nếu số dải ≠ n thì `throw new Error(\`expected ${n} frames, found ${k}\`)`.
  - `measure(img, {x0,x1}): {top, bottom, cx}`. `bottom` là hàng đục thấp nhất. `cx` là tâm x của các pixel đục trong 6% chiều cao cuối, tức điểm chân hoặc đáy bồ đoàn.
  - `placeInCell(frameImg, m, scale, cell = {w:192, h:240, ax:96, ay:232}): img`. Co ảnh theo `scale`, đặt sao cho `(cx, bottom)` rơi đúng `(ax, ay)`. Phần tràn ô thì cắt bỏ và ghi cảnh báo.
  - `normScale(measures, rule, targetH): number`, với `rule` là `'first'|'last'|'median'`. Trả về `targetH / chiều cao của frame được chọn`. **Một tỉ lệ dùng chung cho cả dải**, để frame lạy không bị phóng to.
- `prompts.json`: mỗi action có `{frames, rule, targetH, desc}`. Dải đứng (`walk_*`) dùng `median`, target 224. `idle` dùng `first`, target 150. **Các dải ngồi bám theo `idle` để chỗ nối không giật:** `sit_down` dùng `last`, `bow` và `thank` dùng `first`, với target = chiều cao `idle` đã đo sau khi chuẩn hoá (`build.mjs` xử lý `idle` trước). Nếu frame đầu của `sit_down` lệch quá 5% so với chiều cao `walk_back` thì in cảnh báo. Có thêm `skinScale: {child: 0.8}`.
- `build.mjs` ghi `assets/sprites/manifest.json` theo schema:
  ```json
  { "version": 2, "cell": [192,240], "anchor": [96,232], "alias": {"master":"monk"},
    "skins": { "man": { "src": "man.webp", "seatH": 150,
      "actions": { "walk_back": {"row":0,"frames":6,"stride":22,"loop":true},
                   "sit_down": {"row":3,"frames":5,"fps":8},
                   "stand_up": {"row":3,"frames":5,"fps":8,"reverse":true},
                   "idle": {"row":4,"frames":1,"loop":true},
                   "bow": {"row":5,"frames":6,"fps":8,"yoyo":true,"hold":0.6},
                   "thank": {"row":6,"frames":4,"fps":6,"yoyo":true,"hold":0.8} } } } }
  ```
  Thứ tự hàng: `walk_back` 0, `walk_side` 1, `walk_front` 2, `sit_down` 3, `idle` 4, `bow` 5, `thank` 6. `seatH` đo từ frame `idle`. `stride` là số px trong ô mà chân đi được giữa hai frame, chỉnh tay trong `prompts.json`.
- `gen.mjs <skin> <action>` ghép prompt = `style` + `desc` + "N frames left to right, evenly spaced, same character, same scale, feet on one baseline, plain flat #FF00FF background, no shadows, no text". Gọi `codex exec --enable image_generation -s read-only -i <ref1> -i <ref2> … -`, **truyền prompt qua stdin** (`-i` nhận nhiều file, nên prompt đặt sau nó có thể bị hiểu là đường dẫn ảnh), với refs là `assets/c_<skin|monk>.png`, `assets/anim_<skin>.png` nếu có, và `tools/sprites/raw/<skin>/walk_back.png` nếu có và action ≠ `walk_back`. Ghi lại thời điểm bắt đầu. Sau khi Codex thoát, **duyệt đệ quy** `~/.codex/generated_images`, lấy file ảnh mới nhất có mtime > thời điểm bắt đầu, chép vào `tools/sprites/raw/<skin>/<action>.png`. Không có file thì exit 1 kèm stdout của codex.

- [ ] **Step 1: Viết test hỏng** `tools/sprites/test/lib.test.mjs` (`node:test` + `assert`). Ảnh tổng hợp tạo bằng `Uint8Array`:
  - `keyBackground removes flat magenta`: ảnh 60×40 nền `#FF00FF`, khối đỏ 10×20 ở giữa → mọi pixel nền có alpha 0, pixel đỏ còn alpha 255.
  - `keyBackground despills edges`: pixel viền là trộn 50/50 giữa `#808080` và `#FF00FF` → alpha nằm trong (0, 255), và sau khi despill thì `|R−G| < 20` (không còn ánh hồng).
  - `splitFrames finds n figures`: 3 khối cách nhau 10 px → 3 dải. Gọi với `n=4` → throw `/expected 4 frames, found 3/`.
  - `measure finds feet`: khối 10×30 đặt ở y 5..34 → `bottom === 34`, `cx` bằng tâm khối ±0.5.
  - `placeInCell aligns anchor`: hai khối cao 30 và 18 đặt vào ô → trong cả hai ô, hàng đục thấp nhất là `232`, và tâm x của hàng đó là `96 ± 1`.
  - `normScale uses one scale per strip`: các frame cao `[100, 60, 100]`, rule `'first'`, target 200 → `2`.
- [ ] **Step 2:** `cd tools/sprites && npm install && node --test test/lib.test.mjs` → FAIL (chưa có module).
- [ ] **Step 3:** Viết `lib.mjs` đúng các chữ ký ở trên. Hàm thuần, không gọi `sharp`. Đọc/ghi file bằng `sharp` chỉ nằm trong `build.mjs`.
- [ ] **Step 4:** `node --test test/lib.test.mjs` → PASS.
- [ ] **Step 5:** Viết `build.mjs` và `gen.mjs`. Với mỗi action, `build.mjs` chạy `keyBackground` → `splitFrames` → `measure` → `normScale`, nhân thêm `skinScale` nếu có → `placeInCell`. Ghép các ô thành sheet, xuất `sharp(...).webp({quality: 82, alphaQuality: 90, effort: 6})`. Nếu file > 600 KB thì `throw`. Ghi `out/<skin>_check.png`: các hàng như trong sheet, nền xám caro, một vạch đỏ ngang tại `ay` và một vạch dọc tại `ax` chạy xuyên mọi ô. Thêm một hàng cuối đặt các **cặp chuyển cảnh** cạnh nhau: (frame cuối `walk_back` | frame đầu `sit_down`), (frame cuối `sit_down` | `idle`), (`idle` | frame đầu `bow`), (`idle` | frame đầu `thank`).
- [ ] **Step 6:** Thêm `tools/sprites/raw/`, `tools/sprites/out/` vào `.gitignore`. Chạy `node build.mjs man` khi chưa có ảnh gốc → báo lỗi rõ ràng là thiếu file nào (không ném stack trace thô). Không commit; làm tiếp task sau.

### Task 2: Sinh thử skin `man` → ĐIỂM DỪNG

**Files:** `tools/sprites/raw/man/*.png` (không commit), `assets/sprites/man.webp`, `assets/sprites/manifest.json`, `tools/sprites/out/man_check.png`

- [ ] **Step 1 (thăm dò):** `node gen.mjs man walk_back`. Kiểm tra: (a) Codex nhận đúng prompt từ stdin và có file trong `raw/man/`; (b) ảnh có alpha thật, nền phẳng, hay là ô caro *vẽ* giả trong suốt (trường hợp cuối thì `keyBackground` không xử lý được, phải sửa prompt); (c) đếm được 6 dáng. Ghi lại cả ba vào báo cáo. Nếu (a) hỏng thì sửa cách tìm file trong `gen.mjs` trước khi sinh tiếp.
- [ ] **Step 2:** Lần lượt sinh `walk_side`, `walk_front`, `sit_down`, `idle`, `bow`, `thank`. Mỗi action được sinh lại tối đa 2 lần nếu sai số frame, hoặc lệch mặt, màu áo, tỉ lệ so với `walk_back`. Ghi tổng số lượt sinh đã dùng.
- [ ] **Step 3:** `node build.mjs man` → PASS, `man.webp` ≤ 600 KB.
- [ ] **Step 4:** Mở `out/man_check.png`, tự kiểm: chân mọi frame đứng đúng vạch đỏ, không frame nào bị cắt, cùng khuôn mặt và màu áo, và các cặp chuyển cảnh cao bằng nhau, không lệch ngang (nhất là chỗ đổi neo từ bàn chân sang đáy bồ đoàn). Ghi `stride` ước lượng vào `prompts.json`, rồi build lại.
- [ ] **Step 5: DỪNG.** Gửi chủ `man_check.png`, kích thước file, số lượt sinh, và các chỗ chưa ổn. Chờ chủ duyệt style, ô frame và số frame (Q8, Q9) rồi mới làm tiếp. Nếu chủ đổi Q8 thì sửa `prompts.json` / `cell` rồi lặp lại Task 2.

### Task 3: Runtime — nạp sheet và vẽ

**Files:**
- Create: `assets/js/sprites.js`, `tools/sprites/test/runtime.test.mjs`

**Interfaces (đều nằm trên `window.CDSprites`; file bắt đầu bằng `(function(root){ … root.CDSprites = api; })(globalThis);` để test trên Node chỉ cần `await import()`):**
- `loadSheets(base: string, version: string): Promise<{ get(skin: string): Sheet | null }>`. Thêm `?v=<version>` vào cả URL manifest lẫn URL từng sheet. **Không bao giờ reject.** Lỗi fetch manifest, JSON sai, hay ảnh lỗi đều làm `get()` trả `null` cho skin đó. Tra skin bằng `Object.hasOwn`, có áp `alias`. Kiểm tra manifest: `cell` là 2 số nguyên dương, mỗi action có `row` và `frames` là số nguyên ≥ 0. Skin nào sai thì bỏ skin đó.
- `Sheet = { img: HTMLImageElement, cell: [w,h], anchor: [ax,ay], seatH: number, actions: Record<string, Action> }`.
- `frameOf(action: Action, t: number): number`. Dùng cho action chạy theo thời gian. `reverse` thì đếm ngược. `yoyo` thì chạy 0→n-1, giữ `hold` giây, rồi n-2→0 (không lặp frame đỉnh). `loop` thì quay vòng. Không lặp thì kẹp ở frame cuối. Trả về `-1` khi action không lặp đã chạy xong.
- `drawFrame(ctx, sheet, actionName, frame, x, y, k, flip): number`. Vẽ ô tại `(x, y)` = chân, co theo `k`. Trả về chiều cao trên chân tính bằng px màn hình: `seatH*k` khi action là `idle`/`bow`/`thank`/`sit_down` ở frame cuối, còn lại là `(anchor[1]-8)*k`.

- [ ] **Step 1: Viết test hỏng** (`node --test tools/sprites/test/runtime.test.mjs`, nạp bằng `await import('../../../assets/js/sprites.js')` rồi lấy `globalThis.CDSprites`):
  - `frameOf yoyo with hold`: `{frames:6,fps:10,yoyo:true,hold:0.5}`. t=0 → 0; t=0.55 → 5; t=1.0 → 5 (đang giữ); t=1.15 → 4; t=1.65 → `-1`.
  - `frameOf reverse`: `{frames:5,fps:10,reverse:true}`, t=0 → 4, t=0.45 → 0, t=0.6 → `-1`.
  - `loadSheets survives missing manifest`: gán `globalThis.fetch = async () => { throw new Error('x') }` → `get('man') === null`.
  - `loadSheets rejects bad manifest`: manifest có `cell: [0, 240]` ở cấp gốc → `get('man')` trả `null`. Manifest hợp lệ ở cấp gốc nhưng skin `man` có `actions.bow.row = -1` → `get('man')` trả `null`. Gọi `get('__proto__')` → `null`. (Test không được chứa skin hợp lệ nào, vì trên Node không có `Image`.)
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Viết `loadSheets`, `frameOf`, `drawFrame` (ảnh dùng `new Image()`; trên Node test thì `fetch` bị chặn trước khi cần tới ảnh, nên không cần giả `Image`).
- [ ] **Step 4:** Chạy → PASS. Không commit; làm tiếp task sau.

### Task 4: Runtime — đường đi, chuyển động, máy trạng thái

**Files:**
- Modify: `assets/js/sprites.js`, `tools/sprites/test/runtime.test.mjs`

**Interfaces:**
- `makePath(points: {x,y}[]): { length: number, at(s: number): {x,y} }`. Catmull-Rom centripetal (alpha 0.5), lặp điểm đầu và điểm cuối làm điểm điều khiển. Bảng độ dài cung lấy 24 mẫu mỗi đoạn. `at` kẹp `s` trong `[0, length]`.
- `Actor` (object thường, trang được đọc): `{ x, y, state, dir: 'back'|'side'|'front', flip, frame, queue: string[], … }`. `state` ∈ `'walk'|'sit_down'|'idle'|'act'|'stand_up'|'exit'|'gone'`.
- `newActor(x, y, seated: boolean): Actor`
- `walk(a, points, then: 'sit'|'gone')`: dựng path từ `{x: a.x, y: a.y}` cộng `points`, **giữ `a.v`** (tốc độ hiện tại).
- `enqueue(a, action: 'bow'|'thank', delay = 0)`: tối đa 2 phần tử. Bỏ qua nếu trùng phần tử cuối. Đang `act` mà action giống action đang chạy cũng bỏ qua.
- `leave(a, exitPoints)`: nếu đang ngồi thì `stand_up` → `exit` theo `exitPoints` → `gone`. Nếu đang `walk` thì `walk(a, exitPoints, 'gone')` ngay. Xoá hàng đợi.
- `step(a, dt, sheet: Sheet|null, speedAt: (y)=>number, k: number)`:
  - Đi: `ramp = clamp(min(traveled/60, remaining/90), 0.2, 1)`, nhưng khi `remaining < 1` thì về đích. `a.v` tiến dần về `speedAt(a.y)*ramp`. Mỗi bước, quãng đi = `a.v*dt`, không vượt `remaining`.
  - Frame đi = `floor(dist / (stride*k)) % frames`, với `dist` là quãng đường cộng dồn trên path. Không tính theo thời gian.
  - Hướng: lấy vector vận tốc `(vx, vy)`. Sang `side` khi `|vx| > 1.4|vy|`. Về `back`/`front` khi `|vy| > 1.0|vx|`. Giữa hai ngưỡng thì giữ hướng cũ. `flip = vx < 0` chỉ cập nhật khi đang `side`. Action dùng: `back` → `walk_back`, `side` → `walk_side`, `front` → `walk_front`.
  - Tới đích: `then:'sit'` → `sit_down` → `idle`. `then:'gone'` → `gone`.
  - `idle` mà có hàng đợi và đã hết `delay` → `act` → hết action (`frameOf === -1`) → `idle`.
  - `sheet === null`: `walk` nhảy tới cuối path ngay (hoặc `gone`), mọi action coi như xong ngay.
- `WAVE_ROW_DELAY = 0.18` giây. `waveDelay(rowFromFront: number): number` = `rowFromFront*WAVE_ROW_DELAY + Math.random()*0.08`.

- [ ] **Step 1: Viết test hỏng:**
  - `path endpoints and monotonic length`: `makePath([{x:540,y:2020},{x:540,y:1500},{x:700,y:1480}])`. `at(0)` là điểm đầu, `at(length)` là điểm cuối (±0.5). Lấy 50 mẫu, khoảng cách giữa hai mẫu liên tiếp nằm trong `length/50 ± 15%`.
  - `walk accelerates then stops exactly`: path thẳng dài 400, `speedAt = () => 200`, bước 1/60 s. Tốc độ 5 bước đầu tăng dần. Tới đích thì `x,y` trùng điểm cuối, `state === 'sit_down'`. Không bước nào vượt quá đích.
  - `walk frames follow distance not time`: 2 actor cùng path, một actor `speedAt` 100, một actor 200. Sau khi mỗi actor đi được 120 px, `frame` của hai actor bằng nhau.
  - `direction has hysteresis`: cho vector vận tốc dao động quanh tỉ lệ `|vx|/|vy| = 1.2` → `dir` không đổi trong 30 bước.
  - `retarget keeps position and speed`: đi được nửa đường, gọi `walk(a, [mới], 'sit')` → `x, y, v` sau lời gọi bằng trước lời gọi.
  - `queue is capped and deduped`: `enqueue` bow, bow, thank, bow → `queue` là `['bow','thank']`. Thêm một lần `bow` nữa vẫn tối đa 2 phần tử.
  - `bow during walk waits for idle`: `enqueue` bow khi đang `walk`. `state` chỉ thành `act` sau khi đã `idle`.
  - `leave from seat stands up then exits`: chuỗi state là `stand_up → exit → gone`.
  - `step with null sheet snaps to seat`: `walk` rồi `step(…, null, …)` một lần → `idle` tại ghế.
  - `waveDelay front row first`: `waveDelay(0) < waveDelay(3)`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Viết đúng các chữ ký trên.
- [ ] **Step 4:** Chạy cả file test → PASS. Không commit; làm tiếp task sau.

### Task 5: Tích hợp `live/overlay.html`

**Files:**
- Modify: `live/overlay.html` (khối assets ~91-100, ghế ~102-141, `ws.onmessage` ~222-239, vòng vẽ người ~284-309). **Không đụng 319-327.**

**Interfaces:** Consumes `CDSprites.*` từ Task 3–4.

- [ ] **Step 1:** Thêm `<script src="/assets/js/sprites.js?v=2"></script>` trước `<script>` chính. Trong script chính: `let SHEETS = { get: () => null }; CDSprites.loadSheets('/assets/sprites/', '2').then(s => SHEETS = s);`. Bỏ `anim_*` khỏi `IMG`, bỏ `ANIM` và `hasAnim` (Q5).
- [ ] **Step 2 (ghế cố định, Q2):** Mỗi visitor có `seatIdx`. `addVisitor` lấy chỉ số ghế trống nhỏ nhất (mảng `seats` đã sắp trước ra sau, giữa ra ngoài). `layout(c)` xếp lại người đang có theo thứ tự `seatIdx` cũ, rồi gọi `walk()` nếu người đó đang đi, còn đang ngồi thì để vòng vẽ lướt có easing như dòng 295 hiện tại.
- [ ] **Step 3 (rời, Q3):** Thêm `const leaving = []`. Khi nhận `leave`: lấy visitor ra khỏi `visitors`/`order`, bỏ vào `leaving`, **giữ `seatIdx` bị chiếm cho tới khi actor sang state `exit`** (khi đó mới nhả ghế); trong `addVisitor`, nếu ghế được chọn còn bị giữ thì bỏ qua `instant`, cho người mới đi bộ vào; rồi gọi `CDSprites.leave(a, [{x: 540, y: seat.y + 25}, {x: 540, y: 2050}])` với delay ngẫu nhiên 0–1.5 s (Review Focus 4). Khi nhận `join` với id đang có trong `leaving`: bỏ khỏi `leaving`, tạo visitor như người mới (Review Focus 1). Khi nhận `state`: `leaving.length = 0`. Vòng vẽ vẽ chung `visitors` và `leaving` (sắp theo `y`), bỏ những actor có `state === 'gone'`. `updateCount` và `renderMerit` chỉ tính `visitors`.
- [ ] **Step 4 (sự kiện):** `join` → `newActor(540, 2020, false)` + `walk(a, [{x:540,y:seat.y+25}, {x:seat.x, y:seat.y}], 'sit')`, hoặc `newActor(seat.x, seat.y, true)` khi `instant`. `chat` → `enqueue(a, 'bow')`. `gift` → `enqueue(a, 'thank')`. `chant` → nếu không `reduce` thì mỗi người đang ngồi `enqueue(a, 'bow', CDSprites.waveDelay(rows-1-seat.r))`. `skin` → chỉ đổi `skin`, không ép ngồi nữa.
- [ ] **Step 5 (vẽ):** Với mỗi actor: `sheet = SHEETS.get(v.skin)`, `k = ws*1.05*260/sheet.seatH`, `step(a, dt, sheet, y => 170+190*clamp(depth(y), 0, 1.5), k)`, rồi `drawFrame(...)`. Thở (`breathe`) chỉ áp khi `state === 'idle'` và không `reduce`. Không có sheet thì giữ đường vẽ ảnh tĩnh + squash `bowK` như hiện tại. Định nghĩa `const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches`.
- [ ] **Step 6 (kiểm trên trình duyệt):** Mở overlay 1080×1920 (headed) và `control.html`. Kiểm lần lượt, mỗi mục một ảnh chụp lưu ở `docs/superpowers/shots/after/`:
  - "Thử tương tác" chat → người đó lạy.
  - Tặng quà → cảm tạ.
  - Đổ 15 → 64 → 100 người: người đang ngồi lướt sang ghế mới, không nhảy.
  - Gây ra lượt rời: đổ 100 người, rồi bật bot (mỗi id bot mới đẩy một người im lặng lâu nhất ra), hoặc gửi "Thử tương tác" với tên mới. Bot chỉ nói chuyện thì không làm ai rời. Kiểm: người rời đứng dậy rồi đi ra, không có hai người chồng lên một ghế, pill không vượt 100/100.
  - "Đọc kinh định kỳ ngay" → làn sóng lạy từ hàng trước ra hàng sau.
  - Đổi skin thành `nun` (chưa có sheet) → vẽ ảnh tĩnh, không lỗi console.
  - Tắt bot rồi bật lại ngay → không có hai nhân vật cùng tên; người vào lại đi tới ghế mới.
- [ ] **Step 7:** Đo FPS ở 100 người + bot nhanh (đoạn script ở Task 0, tab overlay đang được chọn) → ≥ 50. Kiểm hook credit: `git diff live/overlay.html` không có dòng nào trong khối `_q`/`_k`; `browser_evaluate('window.frame.toString().includes("_g(")')` → `true`. Không commit; làm tiếp task sau.

### Task 6: Tích hợp `index.html`

**Files:**
- Modify: `index.html` (assets ~133-146, `addVisitor`/`removeVisitor` ~172-177, nút Rời ~293, demo ~296-299, vòng vẽ ~329-366). **Không đụng 377-385.**

- [ ] **Step 1:** `<script src="assets/js/sprites.js?v=2"></script>` (đường dẫn tương đối) + `loadSheets('assets/sprites/', '2')`. Bỏ `ANIM`/`hasAnim`/`anim_*`.
- [ ] **Step 2:** `addVisitor` tạo actor như Task 5 Step 4, với cửa vào `DOOR = {x: 540, y: 2040}`. Trang này đã dùng ghế cố định (`seat.taken`), giữ nguyên.
- [ ] **Step 3:** Nút "Rời": giải phóng `seat.taken` ngay, chuyển `me` sang danh sách `leaving`, gọi `CDSprites.leave(...)`. Các bước còn lại (hiện cổng vào, tắt nhạc) giữ như cũ. Hoạt động demo: bình luận → `enqueue(v, 'bow')`; `donate` → `enqueue(v, 'thank')`, bỏ `v.bow = 1` khi có sheet. Chạm canvas → `enqueue(me, 'bow')`. Không có làn sóng (Q12).
- [ ] **Step 4:** Vòng vẽ: giống Task 5 Step 5, với `speedAt = y => 150+170*clamp(depth(y), 0, 1.4)` và `k = s*1.05*260/sheet.seatH`. Toast "Đã an tọa" bắn khi `me` chuyển từ `sit_down` sang `idle`.
- [ ] **Step 5:** `python -m http.server 8080` ở gốc repo. Kiểm: vào chánh điện (đi mượt, ngồi xuống), chạm để lạy, tặng quà để cảm tạ, bấm Rời (đứng dậy, đi ra). Chụp ảnh từng bước. Kiểm `window.tick.toString().includes("_g(")` → `true`. Trang này tối đa 36 chỗ (22 người demo + mình), nên đo FPS ở mức đó và ghi rõ trong báo cáo. Không commit; làm tiếp task sau.

### Task 7: Sinh hàng loạt 5 skin còn lại + nghiệm thu

**Files:** `assets/sprites/{woman,granny,monk,nun,child}.webp`, `manifest.json`

- [ ] **Step 1:** Mỗi skin trong `woman granny monk nun child`: chạy `gen.mjs` cho 7 action (thứ tự như Task 2, tối đa 2 lần sinh lại mỗi action), rồi `build.mjs`. Mở `out/<skin>_check.png` tự kiểm như Task 2 Step 4. Ghi bảng: skin, KB, số lượt sinh.
- [ ] **Step 2:** `node --test tools/sprites/test/` → PASS hết.
- [ ] **Step 3:** Overlay 1080×1920 (headed), đổ 100 người, bot nhanh. Đo FPS bằng đoạn script ở Task 0. Yêu cầu **≥ 50**. Chụp `after/overlay-100.png` để so với `before/overlay-100.png`.
- [ ] **Step 4:** Tắt bot khi đang có 100 người → chụp 2 ảnh cách nhau 1 s. Người rời phải dàn trải, không dồn thành một cục (Review Focus 4).
- [ ] **Step 5:** Đổi tên tạm `assets/sprites/manifest.json` → tải lại overlay → mọi người vẽ ảnh tĩnh, không lỗi console → trả lại tên cũ.
- [ ] **Step 6:** Báo chủ: bảng FPS trước/sau, ảnh trước/sau, dung lượng từng sheet, tổng số lượt sinh Codex. **Không commit.** Chờ chủ bảo.

---

## Thứ tự và tính độc lập

`0 → 1 → 2 (DỪNG)` → sau khi chủ duyệt: `3 → 4 → {5, 6} → 7`. Task 7 Step 1 (sinh ảnh) chạy song song với 3–6 được, vì chỉ đụng `assets/sprites/` và `raw/`. Sau Task 3–4, có **3 nhánh độc lập**: Task 5 (overlay), Task 6 (index), Task 7 Step 1 (sinh ảnh). Số này đạt ngưỡng của brief, nên dùng skill `orchestration` cho đoạn đó. Task 0–4 làm tuần tự bằng `subagent-driven-development`.
