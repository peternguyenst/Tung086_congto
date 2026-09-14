# Hướng dẫn bật lưu ảnh trên Cloudinary

Ảnh chụp nằm trên Cloudinary (25 GB miễn phí, không cần thẻ), còn Firestore chỉ
giữ dữ liệu công tơ và ảnh thu nhỏ — nhẹ đi rất nhiều.

---

## ✅ Cấu hình hiện tại (đã chạy được)

```js
window.CLOUDINARY_CONFIG = {
    cloudName: "dywwgf8ru",
    uploadPreset: "ml_default"
};
```

Đang dùng **`ml_default`** — preset unsigned có sẵn của Cloudinary. Đã thử
upload thật: ảnh lên được, xếp đúng thư mục `congto/<mã nhóm>/`, tải lại được
từ CDN, nút Chia sẻ/Tải về hoạt động.

**Hai hạn chế đã biết và chấp nhận:**

| Hạn chế | Hệ quả |
|---|---|
| Preset chưa bật *Return delete token* | Xoá ảnh trong app chỉ bỏ khỏi danh sách, bản gốc vẫn nằm trên Cloudinary. Dọn định kỳ trong Media Library. |
| Preset không giới hạn dung lượng file | Người ngoài đọc mã nguồn trang có thể upload ảnh rác vào tài khoản. Thỉnh thoảng ngó Media Library. |

**Hướng về sau:** dự kiến chuyển sang **máy chủ riêng** để ảnh được bảo vệ đúng
cách (có xác thực, không phải link công khai). Khi đó phần upload trong
`app.js` — hàm `uploadToCloudinary` — là chỗ duy nhất cần sửa.

Muốn siết lại ngay mà chưa cần server riêng thì làm theo các bước dưới đây để
tạo preset riêng, rồi đổi `uploadPreset` thành tên preset mới.

---

## Tạo preset riêng (tuỳ chọn, chặt chẽ hơn `ml_default`)

Làm khi muốn xoá được ảnh từ trong app và chặn upload file quá lớn.

1. Vào Cloudinary → ⚙️ **Settings** → **Upload** → kéo xuống **Upload presets**.
2. Bấm **Add upload preset**.
3. Đặt:
   - **Preset name**: `congto_unsigned`
   - **Signing Mode**: chọn **Unsigned** ← quan trọng nhất
     (để **Signed** là app báo lỗi CORS — đây là lỗi hay gặp nhất)
4. Tìm tuỳ chọn **Return delete token** và **bật lên** — cho phép xoá nhầm ảnh
   trong vòng 10 phút.
5. Đặt **Max file size** khoảng `2000000` (2 MB) — ảnh app nén xong chỉ cỡ
   200–300 KB nên thừa sức.
6. Bấm **Save**.
7. Sửa `index.html`, đổi `uploadPreset` thành `"congto_unsigned"`, rồi commit
   và push như mọi khi.

> Chỉ cần **Cloud name** trong code. **KHÔNG** đưa `API Key` và tuyệt đối không
> đưa `API Secret` vào `index.html` — hai thứ đó phải giữ kín.

---

## Ảnh được sắp xếp thế nào

```
congto/
  TO1-2026-K7X9/      ← mỗi nhóm một thư mục
    p1a2b3c4d5.jpg
    p6e7f8g9h0.jpg
```

Mỗi ảnh còn được gắn tag `congto` + mã nhóm, và ghi kèm số công tơ, nên vào
Media Library gõ số công tơ vào ô tìm kiếm là ra.

Khi xong một đợt thay định kỳ, vào Media Library xoá cả thư mục của nhóm đó.

## Chụp lúc mất sóng thì sao?

Vẫn chụp bình thường. Ảnh được cất tạm trong máy và hiện huy hiệu **⏳** ở góc,
thanh đếm phía trên báo *"⏳ N ảnh chờ tải lên"*. Có sóng trở lại app tự đẩy lên,
không cần làm gì.

Lưu ý: ảnh chờ nằm trên máy người chụp, nên **đừng xoá dữ liệu trang web** khi
còn ảnh đang chờ.

## Hạn mức miễn phí

25 credit/tháng, trong đó **1 credit = 1 GB lưu trữ HOẶC 1 GB băng thông**.
Với cỡ ảnh app đang dùng (~250 KB/ảnh) thì 25 GB ≈ **85.000 ảnh** — thực tế
không bao giờ chạm tới.

Gói Free **không tính tiền vượt mức**: Cloudinary chỉ cảnh báo, và nếu vẫn vượt
thì tạm khoá tài khoản, chứ không phát sinh hoá đơn. Cũng lưu ý gói Free không
reset usage vào ngày 1 hằng tháng.

## ⚠️ Hai điều cần biết

**1. Ảnh để ở link công khai.** Ai có đường link ảnh là xem được, không cần đăng
nhập. Link dài và khó đoán, nhưng đó là "giấu" chứ không phải "khoá". App chỉ
gửi lên Cloudinary **số công tơ**, không gửi tên và địa chỉ khách hàng — nhưng
bản thân tấm ảnh có thể chụp cả nhà cửa, biển số. Nếu đây là hồ sơ chính thức
của đơn vị thì nên hỏi bộ phận IT trước.

**2. Tên preset lộ trong mã nguồn trang web.** Đó là bản chất của upload không
ký. Người ngoài biết được `cloudName` + `uploadPreset` thì về lý thuyết có thể
upload ảnh rác vào tài khoản của bạn. Cách hạn chế:
- Đặt **Max file size** trong preset (bước 3.5).
- Thỉnh thoảng ngó qua Media Library xem có gì lạ.
- Nếu bị lạm dụng: xoá preset cũ, tạo preset tên khác, sửa lại `index.html`.

## Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| `Upload preset must be whitelisted for unsigned uploads` | Preset đang để **Signed**, sửa lại thành **Unsigned** ở bước 3 |
| `Upload preset not found` | Sai tên preset trong `index.html`, hoặc sai `cloudName` |
| Ảnh cứ hiện ⏳ mãi | Máy đang mất mạng, hoặc chưa điền `CLOUDINARY_CONFIG`. Mở app lúc có wifi sẽ tự đẩy lên |
| Lỗi CORS | Preset chưa ở chế độ Unsigned — đây là nguyên nhân phổ biến nhất |
| `File size too large` | Ảnh vượt Max file size đặt ở bước 3.5, nâng giới hạn lên |
