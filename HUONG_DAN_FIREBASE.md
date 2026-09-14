# Hướng dẫn bật đồng bộ & chia sẻ bằng Firebase

App vẫn chạy bình thường khi chưa làm bước này — chỉ là dữ liệu nằm trên một
máy, không chia sẻ được. Làm xong 5 bước dưới đây (khoảng 10 phút) là cả tổ
thấy chung danh sách và ảnh, cập nhật ngay lập tức.

Toàn bộ đều **miễn phí** (gói Spark), không cần thẻ tín dụng.

---

## Bước 1 — Tạo project Firebase

1. Vào https://console.firebase.google.com rồi đăng nhập bằng tài khoản Google.
2. Bấm **Create a project** (Tạo dự án).
3. Đặt tên, ví dụ `thay-cong-to`.
4. Hỏi **Enable Google Analytics** → chọn **tắt** (không cần), bấm **Create project**.

## Bước 2 — Bật Firestore Database

1. Menu trái → **Build** → **Firestore Database**.
2. Bấm **Create database**.
3. Chọn location: **asia-southeast1 (Singapore)** — gần Việt Nam nhất, chạy nhanh nhất.
   *Lưu ý: chọn xong KHÔNG đổi lại được.*
4. Chọn **Start in production mode** → **Create**.
   (Bước 4 sẽ đặt quyền truy cập cho đúng.)

## Bước 3 — Lấy cấu hình và dán vào `index.html`

1. Bấm biểu tượng ⚙️ (góc trên trái) → **Project settings**.
2. Kéo xuống mục **Your apps** → bấm biểu tượng **</>** (Web).
3. Đặt nickname bất kỳ (`congto-web`), **KHÔNG** tick "Firebase Hosting" → **Register app**.
4. Màn hình hiện ra một khối `firebaseConfig = { ... }`. Copy phần trong ngoặc.
5. Mở file `index.html`, tìm dòng `window.FIREBASE_CONFIG = {` và dán các giá trị vào:

```js
window.FIREBASE_CONFIG = {
    apiKey: "AIzaSyD...",
    authDomain: "thay-cong-to.firebaseapp.com",
    projectId: "thay-cong-to",
    storageBucket: "thay-cong-to.appspot.com",
    messagingSenderId: "123456789012",
    appId: "1:123456789012:web:abc123def456"
};
```

6. Lưu file, commit và push lên GitHub như mọi khi.

## Bước 4 — Đặt quyền truy cập (Rules)

Vào **Firestore Database** → tab **Rules**, xoá hết và dán đoạn này rồi bấm **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /teams/{teamId}/{document=**} {
      // Chỉ ai biết mã nhóm mới đọc/ghi được.
      // Mã phải dài tối thiểu 8 ký tự để người ngoài không đoán ra.
      allow read, write: if teamId.size() >= 8;
    }
  }
}
```

> **Quan trọng:** app không có đăng nhập, nên **mã nhóm chính là mật khẩu**.
> Hãy đặt mã khó đoán, ví dụ `TO1-2026-K7X9` chứ đừng đặt `TO1` hay `TEST`.
> Ai có mã là xem và sửa được dữ liệu của nhóm.

## Bước 5 — Dùng thử

1. Mở app trên điện thoại → thẻ **☁️ Đồng bộ & chia sẻ** → **⚙️ Cài đặt nhóm**.
2. Nhập **mã nhóm** (vd `TO1-2026-K7X9`) và **tên bạn** → bấm **🔗 Kết nối nhóm**.
3. Huy hiệu góc phải chuyển thành **🟢 TO1-2026-K7X9** là xong.
4. Import file Excel như bình thường — dữ liệu tự lên nhóm.
5. Bấm **📤 Chia sẻ link mời vào nhóm** rồi gửi Zalo cho anh em. Người nhận
   mở link là vào thẳng nhóm, không phải gõ mã.

---

## Chụp ảnh

- Mỗi công tơ có ô **📷 Ảnh hiện trường**:
  - **📷 Chụp** — mở thẳng camera sau.
  - **🖼 Chọn** — lấy ảnh có sẵn trong máy (chọn được nhiều ảnh một lúc).
- Ảnh được **tự động nén** (cạnh dài tối đa 1280px) nên nhẹ, tốn rất ít 3G/4G
  mà vẫn đọc rõ số công tơ.
- Bấm vào ảnh để xem to, có nút **Chia sẻ** (gửi thẳng Zalo/Messenger),
  **Tải về** và **Xóa ảnh**.
- Bộ lọc **📷 Có ảnh** để rà lại xem công tơ nào đã chụp, công tơ nào chưa.

## Mất sóng thì sao?

Vẫn dùng bình thường. App lưu tạm trên máy, có sóng lại tự đẩy lên nhóm.
Huy hiệu lúc đó hiện **🟢 TO1-... (ngoại tuyến)**.

## Hạn mức miễn phí (gói Spark)

| Mục | Hạn mức |
|---|---|
| Dung lượng lưu trữ | **1 GB tổng cộng** |
| Lượt đọc | 50.000 / ngày |
| Lượt ghi | 20.000 / ngày |
| Lượt xoá | 20.000 / ngày |
| Băng thông tải xuống | 10 GB / tháng |

**Không mục nào đáng lo.** Ảnh gốc đã chuyển sang Cloudinary (xem
`HUONG_DAN_CLOUDINARY.md`), Firestore chỉ còn giữ dữ liệu công tơ và ảnh thu
nhỏ (~8 KB/ảnh) — 1 GB đủ cho khoảng **125.000 ảnh**, tức là dùng mãi không hết.

Lượt đọc/ghi cũng rất xa hạn mức: mỗi lần chụp ảnh hay đánh dấu "đã thay" chỉ
tốn 1 lượt ghi, và app có bộ nhớ đệm offline nên mở app không phải đọc lại toàn
bộ danh sách.

> Nếu **chưa** cấu hình Cloudinary, ảnh gốc sẽ nằm trong Firestore và 1 GB chỉ
> chứa được khoảng 3.000–4.000 ảnh (đầy sau ~2–4 tháng nếu tổ làm 30–50 công
> tơ/ngày). Xem `LUU_ANH.md` để so sánh các phương án.

## Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| 🔴 Lỗi đồng bộ — *Missing or insufficient permissions* | Chưa Publish Rules ở Bước 4, hoặc mã nhóm ngắn hơn 8 ký tự |
| Vẫn hiện 💾 Lưu trên máy | Chưa dán `FIREBASE_CONFIG`, hoặc dán thiếu `apiKey`/`projectId` |
| Bấm Chụp không mở camera | Trang phải chạy qua **https** (GitHub Pages có sẵn https), và phải cho phép quyền camera |
| Người khác không thấy dữ liệu | Kiểm tra hai máy dùng **đúng cùng một mã nhóm** (mã không phân biệt hoa thường, tự chuyển thành IN HOA) |
