/* =========================================================================
   Thay Công Tơ Định Kỳ
   - Dữ liệu lưu trên máy (localStorage) và đồng bộ real-time qua Firestore
     khi đã nhập "mã nhóm".
   - Ảnh chụp: nén tự động, ảnh nhỏ (thumbnail) nằm trong bản ghi công tơ,
     ảnh đầy đủ nằm riêng để không làm nặng lúc đồng bộ.
   ========================================================================= */

/* ---------------------------- Trạng thái ---------------------------- */
let meterData = [];
let currentFilter = 'all';
let excelRows = [];
let excelHeaders = [];

let teamCode = localStorage.getItem('teamCode') || '';
let userName = localStorage.getItem('userName') || '';

let db = null;            // Firestore instance
let unsubscribe = null;   // huỷ listener real-time
let cloudReady = false;   // đang đồng bộ với nhóm hay không

/* Cỡ ảnh chụp: 1280px / 0.75 đọc rõ số công tơ mà vẫn nhẹ.
   Muốn tiết kiệm dung lượng hơn nữa thì hạ xuống 1024 / 0.65. */
const PHOTO_MAX_SIDE  = 1280;
const PHOTO_QUALITY   = 0.75;
const MAX_FULL_CHARS  = 700000;  // trần 1 ảnh (Firestore chỉ cho 1MB/bản ghi)
const MAX_THUMB_CHARS = 20000;   // ảnh nhỏ nhúng trong bản ghi công tơ

/* ---------------------------- Tiện ích ---------------------------- */
function uid(prefix) {
    return (prefix || 'm') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function saveLocal() {
    try {
        localStorage.setItem('meterData', JSON.stringify(meterData));
    } catch (e) {
        toast('⚠️ Bộ nhớ máy đã đầy, không lưu được bản sao offline');
    }
}

function escapeHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function norm(str) {
    return String(str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]/g,'');
}

function normalizePhone(phone) {
    return String(phone||'').replace(/[^0-9+]/g,'');
}

function nowStr() {
    return new Date().toLocaleString('vi-VN');
}

let toastTimer = null;
function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function byId(id) {
    return meterData.find(m => m.id === id);
}

/* ------------------- Kho ảnh cục bộ (IndexedDB) -------------------
   localStorage quá nhỏ cho ảnh, nên ảnh đầy đủ ở chế độ offline được
   cất trong IndexedDB. */
const PhotoStore = (function () {
    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open('congto-photos', 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('photos')) {
                    req.result.createObjectStore('photos');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    function run(mode, fn) {
        return open().then(idb => new Promise((resolve, reject) => {
            const tx = idb.transaction('photos', mode);
            const req = fn(tx.objectStore('photos'));
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        }));
    }

    return {
        put: (key, val) => run('readwrite', s => s.put(val, key)),
        get: (key)      => run('readonly',  s => s.get(key)),
        del: (key)      => run('readwrite', s => s.delete(key)),
        clear: ()       => run('readwrite', s => s.clear())
    };
})();

/* ---------------------------- Firebase ---------------------------- */
function firebaseConfigured() {
    const c = window.FIREBASE_CONFIG || {};
    return !!(c.apiKey && c.projectId);
}

function initFirebase() {
    if (!firebaseConfigured()) return false;
    if (db) return true;
    try {
        if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        db = firebase.firestore();
        // Cho phép làm việc khi mất sóng, có mạng lại tự gửi lên
        db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
        return true;
    } catch (e) {
        setSyncBadge('err', '⚠️ Lỗi Firebase');
        document.getElementById('syncHint').textContent = 'Lỗi khởi tạo Firebase: ' + e.message;
        return false;
    }
}

function metersCol() {
    return db.collection('teams').doc(teamCode).collection('meters');
}

function photosCol() {
    return db.collection('teams').doc(teamCode).collection('photos');
}

function setSyncBadge(state, text) {
    const el = document.getElementById('syncBadge');
    if (!el) return;
    el.className = 'sync-badge' + (state ? ' ' + state : '');
    el.textContent = text;
}

function toggleSyncPanel() {
    const b = document.getElementById('syncBody');
    b.style.display = b.style.display === 'block' ? 'none' : 'block';
}

function connectTeam() {
    const code = document.getElementById('teamInput').value.trim().toUpperCase();
    userName = document.getElementById('userInput').value.trim();
    localStorage.setItem('userName', userName);

    if (!code) { alert('Nhập mã nhóm trước đã!'); return; }
    if (!/^[A-Z0-9_-]{8,40}$/.test(code)) {
        alert('Mã nhóm phải dài ít nhất 8 ký tự, chỉ gồm chữ, số, dấu - hoặc _.' +
              ' Mã này chính là mật khẩu của nhóm nên đặt khó đoán, VD: TO1-2026-K7X9');
        return;
    }
    if (!firebaseConfigured()) {
        alert('Chưa dán cấu hình Firebase vào index.html.\nXem file HUONG_DAN_FIREBASE.md để làm theo từng bước.');
        return;
    }
    if (!initFirebase()) return;

    // Giữ bản sao trước khi listener của nhóm ghi đè dữ liệu trên máy
    const localBackup = meterData.map(normalizeItem);
    teamCode = code;
    localStorage.setItem('teamCode', teamCode);
    startListening();

    if (localBackup.length) {
        setTimeout(() => {
            if (meterData.length === 0 && cloudReady) {
                const msg = 'Nhóm "' + teamCode + '" đang trống.\n' +
                            'Đẩy ' + localBackup.length + ' công tơ đang có trên máy lên nhóm?';
                if (confirm(msg)) uploadLocalToCloud(localBackup);
            }
        }, 2500);
    }
}

function leaveTeam() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    cloudReady = false;
    teamCode = '';
    localStorage.removeItem('teamCode');
    updateSyncUI();
    toast('Đã ngắt đồng bộ. Dữ liệu vẫn còn trên máy.');
}

function startListening() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    setSyncBadge('off', '⏳ Đang kết nối…');

    unsubscribe = metersCol().orderBy('order').onSnapshot(snap => {
        meterData = snap.docs.map(d => normalizeItem(d.data()));
        saveLocal();
        renderList();
        cloudReady = true;
        const src = snap.metadata.fromCache ? ' (ngoại tuyến)' : '';
        setSyncBadge('on', '🟢 ' + teamCode + src);
        document.getElementById('syncHint').textContent =
            'Đang chia sẻ với nhóm "' + teamCode + '". Mọi thay đổi hiện ngay trên máy người khác.';
    }, err => {
        cloudReady = false;
        setSyncBadge('err', '🔴 Lỗi đồng bộ');
        document.getElementById('syncHint').textContent =
            'Không đồng bộ được: ' + err.message + '. Dữ liệu vẫn lưu trên máy.';
    });
}

async function uploadLocalToCloud(local) {
    if (!local || !local.length) return;
    toast('Đang tải ' + local.length + ' công tơ lên nhóm…');
    await writeBatched(local);
    toast('✅ Đã đẩy dữ liệu lên nhóm ' + teamCode);
}

async function writeBatched(items) {
    for (let i = 0; i < items.length; i += 400) {
        const batch = db.batch();
        items.slice(i, i + 400).forEach(it => batch.set(metersCol().doc(it.id), it));
        await batch.commit();
    }
}

function shareTeamLink() {
    if (!teamCode) { alert('Kết nối nhóm trước đã.'); return; }
    const url = location.origin + location.pathname + '?team=' + encodeURIComponent(teamCode);
    const text = 'Vào nhóm thay công tơ "' + teamCode + '":\n' + url;
    if (navigator.share) {
        navigator.share({ title: 'Nhóm thay công tơ ' + teamCode, text: text, url: url }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => toast('📋 Đã copy link, gửi cho anh em nhé'));
    } else {
        prompt('Copy link này gửi cho anh em:', url);
    }
}

function updateSyncUI() {
    document.getElementById('teamInput').value = teamCode;
    document.getElementById('userInput').value = userName;
    const hint = document.getElementById('syncHint');

    if (!firebaseConfigured()) {
        setSyncBadge('off', '💾 Lưu trên máy');
        hint.textContent = 'Chưa cấu hình Firebase — app vẫn dùng bình thường nhưng chỉ lưu trên máy này. Mở file HUONG_DAN_FIREBASE.md để bật chia sẻ.';
    } else if (!teamCode) {
        setSyncBadge('off', '💾 Lưu trên máy');
        hint.textContent = 'Nhập mã nhóm rồi bấm "Kết nối nhóm" để chia sẻ dữ liệu và ảnh với anh em.';
    }
}

/* ------------------- Ghi dữ liệu (cloud hoặc máy) ------------------- */
function persist(item) {
    item.updatedAt = Date.now();
    if (userName) item.updatedBy = userName;
    saveLocal();
    if (cloudReady) {
        metersCol().doc(item.id).set(item).catch(e => toast('⚠️ Lỗi lưu lên nhóm: ' + e.message));
    }
}

function normalizeItem(item) {
    return {
        id:             item.id || uid(),
        order:          typeof item.order === 'number' ? item.order : 0,
        stt:            item.stt || '',
        soCongToXuong:  item.soCongToXuong || '',
        soCongToLen:    item.soCongToLen || '',
        diaChi:         item.diaChi || '',
        phone:          item.phone || '',
        maTram:         item.maTram || '',
        tenTram:        item.tenTram || '',
        done:           !!item.done,
        time:           item.time || null,
        note:           item.note || '',
        photos:         Array.isArray(item.photos) ? item.photos : [],
        updatedAt:      item.updatedAt || 0,
        updatedBy:      item.updatedBy || ''
    };
}

/* ---------------------------- Import Excel ---------------------------- */
function findHeader(headers, candidates) {
    for (const c of candidates) {
        const found = headers.find(h => h === c || norm(h) === norm(c));
        if (found) return found;
    }
    for (const c of candidates) {
        const nc = norm(c);
        const found = headers.find(h => norm(h).includes(nc) || nc.includes(norm(h)));
        if (found) return found;
    }
    return '';
}

function fillSelect(selId, headers, guessed) {
    const sel = document.getElementById(selId);
    sel.innerHTML = '<option value="">-- Không dùng --</option>';
    headers.forEach(h => {
        if (String(h).startsWith('__EMPTY')) return;
        const opt = document.createElement('option');
        opt.value = h;
        opt.textContent = h;
        if (h === guessed) opt.selected = true;
        sel.appendChild(opt);
    });
}

function onFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            excelRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

            if (excelRows.length === 0) {
                alert('File Excel trống!');
                return;
            }

            excelHeaders = Object.keys(excelRows[0]);
            document.getElementById('mapPanel').style.display = 'block';

            const gXuong  = findHeader(excelHeaders, ['Công tơ', 'cong to', 'công tơ']);
            const gLen    = findHeader(excelHeaders, ['công tơ mới', 'cong to moi', 'Công tơ mới', 'no mới']);
            const gDiaChi = findHeader(excelHeaders, ['Địa chỉ', 'dia chi', 'Địa chỉ sử dụng điện', 'dia chi su dung dien']);
            const gPhone  = findHeader(excelHeaders, ['SĐT', 'Số điện thoại', 'sdt', 'dienthoai', 'phone', 'Điện thoại', 'dien thoai', 'Tel', 'Mobile', 'Số DT', 'so dt', 'SĐT KH', 'sdt kh']);
            const gMaTram = findHeader(excelHeaders, ['Mã trạm', 'ma tram', 'matram']);
            const gTenTram= findHeader(excelHeaders, ['Tên khách hàng', 'ten khach hang', 'Tên trạm', 'ten tram']);
            const gSTT    = findHeader(excelHeaders, ['số thứ tự', 'so thu tu', 'STT', 'stt']);

            fillSelect('selXuong',  excelHeaders, gXuong);
            fillSelect('selLen',    excelHeaders, gLen);
            fillSelect('selDiaChi', excelHeaders, gDiaChi);
            fillSelect('selPhone',  excelHeaders, gPhone);
            fillSelect('selMaTram', excelHeaders, gMaTram);
            fillSelect('selTenTram',excelHeaders, gTenTram);
            fillSelect('selSTT',    excelHeaders, gSTT);

        } catch (err) {
            alert('Lỗi đọc file: ' + err.message);
        }
        event.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}

/* Khoá nhận dạng một công tơ giữa các lần import: ưu tiên NO công tơ xuống
   (công tơ cũ đang lắp tại nhà khách), dòng nào trống thì lùi về công tơ lên. */
function mergeKey(xuong, len) {
    return norm(xuong) || norm(len);
}

/* Hỏi người dùng: gộp thêm hay xoá hết làm lại */
let importModeResolver = null;

function askImportMode(existing, incoming) {
    document.getElementById('imTitle').textContent =
        'Đang có ' + existing + ' công tơ trong danh sách';
    document.getElementById('imDesc').textContent =
        'File Excel vừa chọn có ' + incoming + ' dòng. Bạn muốn làm gì?';
    document.getElementById('importModal').classList.add('show');
    return new Promise(resolve => { importModeResolver = resolve; });
}

function resolveImportMode(mode) {
    document.getElementById('importModal').classList.remove('show');
    const r = importModeResolver;
    importModeResolver = null;
    if (r) r(mode);
}

/* Gộp các dòng Excel vào danh sách hiện có.
   - Trùng khoá  → cập nhật thông tin từ file, GIỮ NGUYÊN trạng thái đã thay,
                   thời gian, ghi chú, ảnh và số điện thoại đã sửa tay.
   - Chưa có     → thêm mới vào cuối danh sách. */
function applyRows(rows) {
    const index = new Map();
    meterData.forEach(m => {
        const k = mergeKey(m.soCongToXuong, m.soCongToLen);
        if (k && !index.has(k)) index.set(k, m);
    });

    let nextOrder = meterData.reduce((mx, m) => Math.max(mx, m.order || 0), -1) + 1;
    let added = 0, updated = 0;
    const touched = [];

    rows.forEach(row => {
        const k = mergeKey(row.soCongToXuong, row.soCongToLen);
        const exist = k ? index.get(k) : null;

        if (exist) {
            if (row.stt)           exist.stt           = row.stt;
            if (row.soCongToXuong) exist.soCongToXuong = row.soCongToXuong;
            if (row.soCongToLen)   exist.soCongToLen   = row.soCongToLen;
            if (row.diaChi)        exist.diaChi        = row.diaChi;
            if (row.maTram)        exist.maTram        = row.maTram;
            if (row.tenTram)       exist.tenTram       = row.tenTram;
            // Số điện thoại đã có trong app có thể là số anh em sửa tay ngoài
            // hiện trường — chỉ điền khi đang trống
            if (!exist.phone && row.phone) exist.phone = row.phone;
            exist.updatedAt = Date.now();
            touched.push(exist);
            updated++;
        } else {
            const item = normalizeItem(Object.assign({ id: uid(), order: nextOrder++ }, row));
            meterData.push(item);
            if (k) index.set(k, item);
            touched.push(item);
            added++;
        }
    });

    saveLocal();
    renderList();
    return { added, updated, touched };
}

async function doImport() {
    const colXuong  = document.getElementById('selXuong').value;
    const colLen    = document.getElementById('selLen').value;
    const colDiaChi = document.getElementById('selDiaChi').value;
    const colPhone  = document.getElementById('selPhone').value;
    const colMaTram = document.getElementById('selMaTram').value;
    const colTenTram= document.getElementById('selTenTram').value;
    const colSTT    = document.getElementById('selSTT').value;

    if (!colXuong && !colLen) {
        alert('Bạn phải chọn ít nhất 1 cột NO công tơ!');
        return;
    }

    // Đọc các dòng hợp lệ ra trước, chưa đụng gì tới dữ liệu đang có
    const rows = [];
    excelRows.forEach((row, idx) => {
        const xuongStr = colXuong ? String(row[colXuong] || '').trim() : '';
        const lenStr   = colLen   ? String(row[colLen]   || '').trim() : '';
        if (!xuongStr && !lenStr) return;

        rows.push({
            stt: colSTT ? String(row[colSTT] || '').trim() : String(idx + 1),
            soCongToXuong: xuongStr,
            soCongToLen: lenStr,
            diaChi:  colDiaChi ? String(row[colDiaChi] || '').trim() : '',
            phone:   colPhone  ? normalizePhone(row[colPhone]) : '',
            maTram:  colMaTram ? String(row[colMaTram] || '').trim() : '',
            tenTram: colTenTram? String(row[colTenTram]|| '').trim() : ''
        });
    });

    if (!rows.length) {
        alert('Không đọc được dòng nào có số công tơ trong file này.');
        return;
    }

    let mode = 'merge';
    if (meterData.length > 0) {
        mode = await askImportMode(meterData.length, rows.length);
        if (!mode) return;                      // người dùng bấm Huỷ
        if (mode === 'replace') await wipeAll();
    }

    const r = applyRows(rows);
    document.getElementById('mapPanel').style.display = 'none';

    if (cloudReady && r.touched.length) {
        toast('Đang tải lên nhóm…');
        try {
            await writeBatched(r.touched);
        } catch (e) {
            alert('Lỗi tải lên nhóm: ' + e.message);
            return;
        }
    }

    alert(r.updated
        ? '✅ Đã gộp xong:\n• Thêm mới ' + r.added + ' công tơ\n• Cập nhật ' + r.updated +
          ' công tơ đã có (giữ nguyên trạng thái đã thay, ảnh và ghi chú)'
        : '✅ Đã import thành công ' + r.added + ' công tơ');
}

/* ---------------------------- Thao tác ---------------------------- */
function setFilter(f) {
    currentFilter = f;
    document.getElementById('btnAll').className     = 'filter-btn' + (f==='all'?' active-all':'');
    document.getElementById('btnPending').className = 'filter-btn' + (f==='pending'?' active-pending':'');
    document.getElementById('btnDone').className    = 'filter-btn' + (f==='done'?' active-done':'');
    document.getElementById('btnPhoto').className   = 'filter-btn' + (f==='photo'?' active-all':'');
    renderList();
}

function toggleDone(id) {
    const item = byId(id);
    if (!item) return;
    item.done = !item.done;
    item.time = nowStr();
    persist(item);
    renderList();
}

function updateNote(id, value) {
    const item = byId(id);
    if (!item) return;
    item.note = value;
    persist(item);
}

function updatePhone(id, value) {
    const item = byId(id);
    if (!item) return;
    item.phone = normalizePhone(value);
    persist(item);
    renderList();
}

async function deleteItem(id) {
    const item = byId(id);
    if (!item) return;
    if (!confirm('Xóa công tơ này' + (item.photos.length ? ' và ' + item.photos.length + ' ảnh' : '') + '?')) return;

    for (const p of item.photos) await removePhotoData(p);
    meterData = meterData.filter(m => m.id !== id);
    saveLocal();
    renderList();
    if (cloudReady) metersCol().doc(id).delete().catch(e => toast('⚠️ ' + e.message));
}

async function clearAll() {
    if (!confirm('Xóa toàn bộ dữ liệu và ảnh' + (cloudReady ? ' CỦA CẢ NHÓM ' + teamCode : '') + '?')) return;
    await wipeAll();
    renderList();
    toast('Đã xóa toàn bộ');
}

async function wipeAll() {
    if (cloudReady) {
        try {
            await deleteCollection(metersCol());
            await deleteCollection(photosCol());
        } catch (e) {
            alert('Lỗi xóa trên nhóm: ' + e.message);
        }
    }
    meterData = [];
    saveLocal();
    await PhotoStore.clear().catch(() => {});
}

async function deleteCollection(ref) {
    while (true) {
        const snap = await ref.limit(300).get();
        if (snap.empty) return;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        if (snap.size < 300) return;
    }
}

/* ============================ ẢNH ============================ */
let pendingMeterId = null;

function takePhoto(id)   { pendingMeterId = id; document.getElementById('cameraInput').click(); }
function pickPhoto(id)   { pendingMeterId = id; document.getElementById('galleryInput').click(); }

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh')); };
        img.src = url;
    });
}

function scaleToDataUrl(img, maxSide, quality) {
    let w = img.naturalWidth  || img.width;
    let h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
}

/* Nén dần cho tới khi ảnh đủ nhỏ để lưu được */
function compress(img, maxSide, quality, maxChars) {
    let side = maxSide, q = quality;
    let data = scaleToDataUrl(img, side, q);
    let guard = 0;
    while (data.length > maxChars && guard++ < 12) {
        if (q > 0.4) q -= 0.12; else { side = Math.round(side * 0.8); q = 0.6; }
        data = scaleToDataUrl(img, side, q);
    }
    return data;
}

async function handlePhotoFiles(files) {
    const meterId = pendingMeterId;
    if (!byId(meterId) || !files || !files.length) return;

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        try {
            toast('📷 Đang xử lý ảnh…');
            const img   = await loadImage(file);
            const full  = compress(img, PHOTO_MAX_SIDE, PHOTO_QUALITY, MAX_FULL_CHARS);
            const thumb = compress(img, 200, 0.6, MAX_THUMB_CHARS);

            const photoId = uid('p');
            // Ảnh gốc cất tạm trên máy trước, kể cả khi đang mất sóng
            await PhotoStore.put(photoId, full);

            const item = byId(meterId);
            if (!item) return;
            item.photos.push({
                id: photoId, thumb: thumb, time: nowStr(),
                by: userName || '', pending: true
            });
            persist(item);
            renderList();
            toast('✅ Đã lưu ảnh (' + Math.round(full.length / 1024) + ' KB)');
        } catch (e) {
            alert('Lỗi khi lưu ảnh: ' + e.message);
        }
    }
    uploadPending();
}

/* ------------------- Cloudinary ------------------- */
function cloudinaryConfigured() {
    const c = window.CLOUDINARY_CONFIG || {};
    return !!(c.cloudName && c.uploadPreset);
}

/* Đẩy 1 ảnh lên Cloudinary bằng "unsigned upload preset" (không cần máy chủ riêng) */
async function uploadToCloudinary(photoId, dataUrl, item) {
    const c = window.CLOUDINARY_CONFIG;
    const form = new FormData();
    form.append('file', dataUrl);
    form.append('upload_preset', c.uploadPreset);
    form.append('public_id', photoId);
    form.append('folder', 'congto/' + (teamCode || 'ca-nhan'));
    form.append('tags', ['congto', teamCode || 'ca-nhan'].join(','));
    // Chỉ gắn số công tơ để dễ tra cứu — không đưa tên/địa chỉ khách hàng lên Cloudinary
    const soCongTo = item ? (item.soCongToLen || item.soCongToXuong || '') : '';
    if (soCongTo) form.append('context', 'so_cong_to=' + soCongTo);

    const res = await fetch('https://api.cloudinary.com/v1_1/' + c.cloudName + '/image/upload', {
        method: 'POST', body: form
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    }
    return json;   // secure_url, public_id, bytes, delete_token (nếu preset bật)
}

let uploading = false;

/* Đẩy nốt những ảnh còn đang chờ (chụp lúc mất sóng) */
async function uploadPending() {
    if (uploading || !cloudinaryConfigured() || !navigator.onLine) return;
    uploading = true;
    try {
        for (const item of meterData.slice()) {
            for (const meta of item.photos.filter(p => p.pending)) {
                const data = await PhotoStore.get(meta.id);
                if (!data) { meta.pending = false; meta.missing = true; persist(item); continue; }
                try {
                    const r = await uploadToCloudinary(meta.id, data, item);
                    meta.url = r.secure_url;
                    meta.publicId = r.public_id;
                    if (r.delete_token) { meta.deleteToken = r.delete_token; meta.deleteTokenAt = Date.now(); }
                    meta.pending = false;
                    persist(byId(item.id) || item);
                    // Ảnh đã nằm trên Cloudinary, xoá bản tạm để đỡ tốn bộ nhớ máy
                    await PhotoStore.del(meta.id).catch(() => {});
                } catch (e) {
                    toast('⚠️ Chưa tải được ảnh lên: ' + e.message);
                    return;   // để lần sau thử lại, tránh spam lỗi
                }
            }
        }
    } finally {
        uploading = false;
        renderList();
    }
}

function countPending() {
    return meterData.reduce((n, m) => n + m.photos.filter(p => p.pending).length, 0);
}

async function loadPhotoData(meta) {
    if (meta.url) return meta.url;                       // Cloudinary: dùng thẳng URL
    const local = await PhotoStore.get(meta.id);
    if (local) return local;
    if (cloudReady) {                                    // ảnh cũ lưu trong Firestore
        const doc = await photosCol().doc(meta.id).get();
        if (doc.exists) return doc.data().data;
    }
    return null;
}

async function removePhotoData(meta) {
    await PhotoStore.del(meta.id).catch(() => {});
    if (cloudReady) await photosCol().doc(meta.id).delete().catch(() => {});

    // Cloudinary chỉ cho xoá từ trình duyệt trong vòng 10 phút sau khi tải lên;
    // quá hạn thì bỏ tham chiếu là xong, file gốc dọn sau trong Media Library.
    if (meta.deleteToken && Date.now() - (meta.deleteTokenAt || 0) < 10 * 60 * 1000) {
        try {
            await fetch('https://api.cloudinary.com/v1_1/' + window.CLOUDINARY_CONFIG.cloudName + '/delete_by_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: meta.deleteToken })
            });
        } catch (e) { /* không sao, ảnh đã biến mất khỏi app */ }
    }
}

/* ---------- Xem ảnh phóng to ---------- */
let lbMeterId = null, lbPhotoId = null, lbSrc = null;

async function openPhoto(meterId, photoId) {
    const item = byId(meterId);
    const meta = item && item.photos.find(p => p.id === photoId);
    if (!meta) return;

    lbMeterId = meterId;
    lbPhotoId = photoId;
    lbSrc = null;

    const info = '⏱ ' + meta.time + (meta.by ? ' · 👤 ' + meta.by : '') +
                 (meta.pending ? ' · ⏳ chưa tải lên' : '');
    document.getElementById('lbImg').src = meta.thumb;   // hiện tạm ảnh nhỏ
    document.getElementById('lbInfo').textContent = info + ' — đang tải ảnh gốc…';
    document.getElementById('lightbox').classList.add('show');

    try {
        const src = await loadPhotoData(meta);
        if (lbPhotoId !== photoId) return;   // người dùng đã chuyển ảnh khác
        if (src) {
            lbSrc = src;
            document.getElementById('lbImg').src = src;
        }
        document.getElementById('lbInfo').textContent = info + (src ? '' : ' — không tìm thấy ảnh gốc');
    } catch (e) {
        document.getElementById('lbInfo').textContent = 'Lỗi tải ảnh: ' + e.message;
    }
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('show');
    document.getElementById('lbImg').src = '';
    lbMeterId = lbPhotoId = lbSrc = null;
}

/* Lấy ảnh dạng Blob, dù ảnh đang là base64 trên máy hay URL Cloudinary */
async function currentPhotoBlob() {
    if (!lbSrc) return null;
    if (lbSrc.indexOf('data:') === 0) return dataUrlToBlob(lbSrc);
    const res = await fetch(lbSrc);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.blob();
}

function photoFileName() {
    const item = byId(lbMeterId);
    const base = item ? (item.soCongToLen || item.soCongToXuong || item.stt || 'congto') : 'congto';
    return 'CT_' + String(base).replace(/[^A-Za-z0-9_-]/g, '') + '_' + lbPhotoId + '.jpg';
}

function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

async function downloadPhoto() {
    if (!lbSrc) { toast('Ảnh chưa tải xong'); return; }
    const name = photoFileName();
    try {
        const blob = await currentPhotoBlob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
        window.open(lbSrc, '_blank');   // dự phòng: mở ảnh ra tab mới để nhấn giữ lưu về
    }
}

async function sharePhoto() {
    if (!lbSrc) { toast('Ảnh chưa tải xong'); return; }
    const item = byId(lbMeterId);
    const caption = item
        ? 'Công tơ ' + (item.soCongToLen || item.soCongToXuong) + (item.diaChi ? ' — ' + item.diaChi : '')
        : 'Ảnh công tơ';
    try {
        const blob = await currentPhotoBlob();
        const file = new File([blob], photoFileName(), { type: 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text: caption });
            return;
        }
    } catch (e) { /* người dùng huỷ, hoặc trình duyệt không hỗ trợ */ }
    downloadPhoto();
    toast('Trình duyệt không chia sẻ trực tiếp được — đã tải ảnh về máy');
}

async function deleteCurrentPhoto() {
    if (!lbPhotoId) return;
    if (!confirm('Xóa ảnh này?')) return;
    const item = byId(lbMeterId);
    const meta = item && item.photos.find(p => p.id === lbPhotoId);
    if (!meta) return;
    const photoId = lbPhotoId;
    closeLightbox();

    await removePhotoData(meta);
    item.photos = item.photos.filter(p => p.id !== photoId);
    persist(item);
    renderList();
    toast('Đã xóa ảnh');
}

/* ---------------------------- Hiển thị ---------------------------- */
function renderList() {
    const list = document.getElementById('meterList');
    const search = document.getElementById('searchInput').value.trim().toLowerCase();
    list.innerHTML = '';

    const filtered = meterData.filter(item => {
        const ok = !search ||
            (item.stt||'').toLowerCase().includes(search) ||
            (item.soCongToLen||'').toLowerCase().includes(search) ||
            (item.soCongToXuong||'').toLowerCase().includes(search) ||
            (item.diaChi||'').toLowerCase().includes(search) ||
            (item.phone||'').toLowerCase().includes(search) ||
            (item.maTram||'').toLowerCase().includes(search) ||
            (item.tenTram||'').toLowerCase().includes(search);
        if (!ok) return false;
        if (currentFilter === 'pending') return !item.done;
        if (currentFilter === 'done')    return item.done;
        if (currentFilter === 'photo')   return item.photos.length > 0;
        return true;
    });

    filtered.forEach(item => {
        const id = item.id;
        const div = document.createElement('div');
        div.className = 'meter-card ' + (item.done ? 'done-card' : 'pending-card');

        const tramHtml = (item.maTram || item.tenTram) ? `
            <div class="info-box">
                🏭 Trạm / KH<br>
                <div style="font-size:15px;margin-top:4px">
                    ${item.maTram ? '<b>Mã trạm:</b> '+escapeHtml(item.maTram) : ''}
                    ${item.maTram && item.tenTram ? '<br>' : ''}
                    ${item.tenTram ? '<b>Tên:</b> '+escapeHtml(item.tenTram) : ''}
                </div>
            </div>` : '';

        const diaChiHtml = item.diaChi ? `
            <div class="info-box">
                📍 Địa chỉ sử dụng điện<br>
                <div class="address">${escapeHtml(item.diaChi)}</div>
            </div>` : '';

        const phoneVal = item.phone || '';
        const hasPhone = phoneVal.length >= 8;

        const phoneHtml = `
            <div class="info-box" style="border:2px solid ${hasPhone ? '#007aff' : '#eee'}">
                📞 Số điện thoại khách hàng
                <input type="tel" class="phone-input" value="${escapeHtml(phoneVal)}"
                       placeholder="Nhập số điện thoại..."
                       onchange="updatePhone('${id}', this.value)"
                       onclick="this.select()">
                ${hasPhone ? `
                <div class="phone-actions">
                    <a class="call-btn" href="tel:${escapeHtml(phoneVal)}">📲 Gọi ngay</a>
                    <a class="sms-btn" href="sms:${escapeHtml(phoneVal)}">💬 Nhắn tin</a>
                </div>` : `<div style="margin-top:8px;font-size:13px;color:#888">Nhập số rồi nhấn ra ngoài để lưu</div>`}
            </div>`;

        const thumbs = item.photos.map(p => `
            <div class="photo-item" onclick="openPhoto('${id}','${p.id}')">
                <img class="photo-thumb" src="${p.thumb}" alt="Ảnh công tơ">
                ${p.pending ? '<span class="photo-badge">⏳</span>' : ''}
            </div>`).join('');

        const photoHtml = `
            <div class="info-box">
                📷 Ảnh hiện trường <span class="photo-count">(${item.photos.length})</span>
                <div class="photo-strip">
                    <button class="photo-add" onclick="takePhoto('${id}')">📷<small>Chụp</small></button>
                    <button class="photo-add" style="border-color:#34c759;background:#f0fff4;color:#34c759"
                            onclick="pickPhoto('${id}')">🖼<small>Chọn</small></button>
                    ${thumbs}
                </div>
            </div>`;

        div.innerHTML = `
            <div class="stt">STT: <b>${escapeHtml(item.stt)}</b></div>
            ${tramHtml}
            ${diaChiHtml}
            <div class="info-box">
                <span style="color:#ff3b30">🔽</span> NO công tơ xuống<br>
                <div class="meter-number" style="color:#ff3b30">${escapeHtml(item.soCongToXuong) || '—'}</div>
            </div>
            <div class="info-box">
                <span style="color:#34c759">🔼</span> NO công tơ lên<br>
                <div class="meter-number" style="color:#34c759">${escapeHtml(item.soCongToLen) || '—'}</div>
            </div>
            ${phoneHtml}
            ${photoHtml}
            <div>
                <span class="status ${item.done?'done':'not-done'}" onclick="toggleDone('${id}')">
                    ${item.done ? '✓ ĐÃ THAY' : '✗ CHƯA THAY'}
                </span>
            </div>
            ${item.time ? `<div style="margin-top:6px;font-size:12px;color:#888">⏱ ${escapeHtml(item.time)}${item.updatedBy ? ' · 👤 ' + escapeHtml(item.updatedBy) : ''}</div>` : ''}
            <textarea placeholder="📝 Ghi chú..." onchange="updateNote('${id}',this.value)">${escapeHtml(item.note)}</textarea>
            <div class="row">
                <button class="danger" onclick="deleteItem('${id}')">🗑 Xóa</button>
            </div>
        `;
        list.appendChild(div);
    });

    const doneCount  = meterData.filter(m => m.done).length;
    const photoCount = meterData.reduce((n, m) => n + m.photos.length, 0);
    const pending    = countPending();
    document.getElementById('counter').innerHTML = `
        Tổng: <b>${meterData.length}</b>
        &nbsp;|&nbsp; <span style="color:#34c759">Đã thay: <b>${doneCount}</b></span>
        &nbsp;|&nbsp; <span style="color:#ff3b30">Chưa thay: <b>${meterData.length - doneCount}</b></span>
        &nbsp;|&nbsp; 📷 <b>${photoCount}</b> ảnh
        ${pending ? `&nbsp;|&nbsp; <span style="color:#ff9500">⏳ <b>${pending}</b> ảnh chờ tải lên</span>` : ''}
    `;
}

/* ---------------------------- Khởi động ---------------------------- */
(function start() {
    // Nạp dữ liệu đã lưu + nâng cấp bản ghi cũ (thêm id, order, photos)
    const raw = JSON.parse(localStorage.getItem('meterData') || '[]');
    meterData = raw.map((it, idx) => normalizeItem(Object.assign({ order: idx }, it)));
    if (raw.length && raw.some(it => !it.id)) saveLocal();

    // Mã nhóm có thể đến từ link mời: ...?team=TO1-2026
    const fromUrl = new URLSearchParams(location.search).get('team');
    if (fromUrl) teamCode = fromUrl.trim().toUpperCase();

    document.getElementById('cameraInput').onchange = function (e) {
        handlePhotoFiles(Array.from(e.target.files)); e.target.value = '';
    };
    document.getElementById('galleryInput').onchange = function (e) {
        handlePhotoFiles(Array.from(e.target.files)); e.target.value = '';
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
    document.getElementById('userInput').onchange = function () {
        userName = this.value.trim();
        localStorage.setItem('userName', userName);
    };

    // Có sóng trở lại thì đẩy nốt ảnh đã chụp lúc mất mạng
    window.addEventListener('online', () => uploadPending());

    renderList();
    updateSyncUI();

    if (teamCode && firebaseConfigured() && initFirebase()) {
        localStorage.setItem('teamCode', teamCode);
        document.getElementById('teamInput').value = teamCode;
        startListening();
    }

    uploadPending();
})();
