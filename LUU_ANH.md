# Lưu ảnh ở đâu — so sánh các phương án

> **App hiện đang dùng Cloudinary.** Cách cài đặt xem trong
> `HUONG_DAN_CLOUDINARY.md`. File này giữ lại phần so sánh để tham khảo khi
> muốn đổi phương án.

Cách app đang hoạt động:

- **Ảnh gốc** → Cloudinary (25 GB free, không cần thẻ).
- **Ảnh thu nhỏ** → nhúng thẳng trong bản ghi công tơ ở Firestore, nhờ vậy danh
  sách vẫn hiện đủ ảnh khi mất sóng.
- **Chụp lúc mất mạng** → cất tạm trong máy, có sóng lại tự đẩy lên.

## Bảng so sánh

| Phương án | Dung lượng free | Cần thẻ? | Ảnh có được bảo vệ? | Số ảnh chứa được |
|---|---|---|---|---|
| **Firestore** (đang dùng) | 1 GB | Không | ✅ Có, theo mã nhóm | ~3.000–4.000 |
| **Firebase Storage** (Blaze) | 5 GB | **Có** | ✅ Có, theo Rules | ~17.000 |
| **Cloudinary** | 25 GB* | Không | ❌ Link công khai | ~85.000 |
| **ImageKit** | 3 GB | Không | ❌ Link công khai | ~10.000 |
| **Supabase Storage** | 1 GB | Không | ✅ Có, theo RLS | ~3.000–4.000 |

\* Cloudinary tính theo "credit": 25 credit/tháng, 1 credit = 1 GB lưu **hoặc**
1 GB băng thông. Dùng nhiều băng thông thì phần lưu trữ còn lại ít đi.

## ⚠️ Điều cần cân nhắc trước tiên

Ảnh công tơ đi kèm **địa chỉ và tên khách hàng** — đây là dữ liệu của đơn vị,
không phải ảnh cá nhân. Các host ảnh miễn phí (Cloudinary, ImageKit, imgbb,
Imgur…) đều để ảnh ở **link công khai**: ai có đường link là xem được, không
đăng nhập gì cả. Link tuy dài và khó đoán nhưng đó chỉ là "giấu", không phải
"khoá".

Nếu ảnh này dùng làm hồ sơ nghiệm thu chính thức, nên hỏi bộ phận IT / lãnh đạo
đơn vị trước khi đẩy lên dịch vụ ngoài.

## Khuyến nghị (nếu muốn đổi)

**1. Nếu chấp nhận thêm thẻ vào Firebase → Firebase Storage.**
Đây là phương án đúng bài nhất: ảnh vẫn được bảo vệ bằng Rules như dữ liệu công
tơ, cùng một hệ thống, code thay đổi rất ít. 5 GB đầu miễn phí; vượt ra thì
khoảng **0,026 USD/GB/tháng** — 20 GB ảnh chỉ tốn cỡ **0,4 USD/tháng (~10.000đ)**.
Từ 03/02/2026 Google bắt buộc liên kết thẻ mới tạo được bucket, nhưng nằm trong
hạn mức thì hoá đơn vẫn bằng 0.

**2. Nếu không muốn đưa thẻ → Cloudinary.**
Nhiều dung lượng nhất, không cần thẻ, và quan trọng là upload thẳng từ trình
duyệt được (dùng "unsigned upload preset") nên vẫn chạy trên GitHub Pages không
cần máy chủ riêng. Đổi lại: link ảnh công khai. Gói Free không tính tiền vượt
mức — họ cảnh báo rồi khoá tài khoản, nên không sợ phát sinh hoá đơn bất ngờ.

**3. Nếu chỉ dùng cho một đợt thay định kỳ → giữ nguyên Firestore.**
Xong đợt thì tải ảnh về máy/ổ mạng rồi xoá nhóm cũ đi là lại trống.

## Không nên dùng

- **Imgur** — điều khoản cấm dùng cho mục đích công việc/thương mại, và ảnh
  upload ẩn danh hay bị xoá.
- **imgbb, postimages, catbox** và các host ảnh free tương tự — không cam kết
  lưu lâu dài, ảnh có thể biến mất, không phù hợp cho hồ sơ công việc.

## Cách giảm dung lượng ngay, không cần đổi gì

Trong `app.js`, hàm `handlePhotoFiles` đang nén ảnh ở **1280px, chất lượng 0.75**.
Hạ xuống **1024px, chất lượng 0.65** sẽ giảm khoảng 40% dung lượng (tức chứa
được gần gấp đôi số ảnh) mà số công tơ vẫn đọc rõ:

```js
const full  = compress(img, 1024, 0.65, MAX_FULL_CHARS);
```
