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

/* Moi may mot ma rieng: chi may da chup moi chiu trach nhiem day anh do len */
let deviceId = localStorage.getItem('deviceId');
if (!deviceId) {
    deviceId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('deviceId', deviceId);
}

let db = null;            // Firestore instance
let unsubscribe = null;   // huỷ listener real-time
let unsubPhotos = null;   // listener rieng cho anh
let cloudPhotos = [];     // anh cua nhom, moi anh mot ban ghi
let legacyPhotos = new Map();  // anh nhung san trong ban ghi cong to (ban app cu)
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

/* ---------------------- Tên người dùng ---------------------- */
function askName() {
    document.getElementById('nameInput').value = userName;
    document.getElementById('nameModal').classList.add('show');
    setTimeout(() => document.getElementById('nameInput').focus(), 60);
}

function saveName() {
    const value = document.getElementById('nameInput').value.trim();
    if (!value) {
        // Bắt buộc có tên, không thì không ai biết ai làm phần nào
        document.getElementById('nameErr').style.display = 'block';
        document.getElementById('nameInput').focus();
        return;
    }
    setUserName(value);
    closeNameModal();
    toast('Chào ' + userName + '!');
}

function closeNameModal() {
    document.getElementById('nameModal').classList.remove('show');
    document.getElementById('nameErr').style.display = 'none';
}

function setUserName(name) {
    userName = String(name || '').trim();
    localStorage.setItem('userName', userName);
    const box = document.getElementById('userInput');
    if (box) box.value = userName;
    updateWhoAmI();
}

function updateWhoAmI() {
    const el = document.getElementById('whoAmI');
    if (!el) return;
    el.textContent = userName ? '👤 ' + userName + ' — bấm để đổi tên'
                              : '👤 Chưa có tên — bấm để nhập';
    el.className = 'who-chip' + (userName ? '' : ' empty');
}

/* Chưa có tên thì hỏi ngay và không cho bỏ qua — thiếu tên thì mọi việc làm
   đều không biết của ai. Hộp thoại phủ kín màn hình nên phải nhập mới dùng tiếp được. */
function requireName() {
    if (!userName) setTimeout(askName, 300);
}

function toggleSyncPanel() {
    const b = document.getElementById('syncBody');
    b.style.display = b.style.display === 'block' ? 'none' : 'block';
}

/* Tên nhóm để tự do: chữ Việt có dấu, khoảng trắng, chữ hoa chữ thường đều được.
   Chỉ chặn đúng mấy thứ Firestore không cho đặt làm tên bản ghi, cộng độ dài
   tối thiểu cho khớp với Rules đang publish (teamId.size() >= 8). */
function cleanTeamCode(raw) {
    return String(raw || '').trim().replace(/\s+/g, ' ');
}

function teamCodeError(code) {
    if (!code) return 'Nhập tên nhóm trước đã!';
    if (code.indexOf('/') >= 0) return 'Tên nhóm không được chứa dấu gạch chéo /';
    if (code === '.' || code === '..') return 'Tên nhóm không hợp lệ.';
    if (/^__.*__$/.test(code)) return 'Tên nhóm không được vừa mở đầu vừa kết thúc bằng __';
    if (code.length > 100) return 'Tên nhóm dài quá, tối đa 100 ký tự.';
    if (code.length < 8) {
        return 'Tên nhóm phải dài ít nhất 8 ký tự.' +
               ' Tên này chính là mật khẩu vào nhóm — ai biết là xem và sửa được,' +
               ' nên đặt dài và khó đoán một chút. VD: Tổ 1 Hoàn Kiếm 2026';
    }
    return '';
}

function connectTeam() {
    const code = cleanTeamCode(document.getElementById('teamInput').value);
    // Chỉ ghi đè khi có nhập, tránh xoá trắng tên đang có
    const typedName = document.getElementById('userInput').value.trim();
    if (typedName) setUserName(typedName);

    const err = teamCodeError(code);
    if (err) { alert(err); return; }
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
    requireName();

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
    stopListening();
    cloudPhotos = [];
    legacyPhotos = new Map();
    cloudReady = false;
    teamCode = '';
    localStorage.removeItem('teamCode');
    updateSyncUI();
    toast('Đã ngắt đồng bộ. Dữ liệu vẫn còn trên máy.');
}

function startListening() {
    stopListening();
    setSyncBadge('off', '⏳ Đang kết nối…');

    unsubscribe = metersCol().orderBy('order').onSnapshot(snap => {
        meterData = snap.docs.map(d => normalizeItem(d.data()));
        // Ảnh nhúng sẵn trong bản ghi công tơ là của bản app cũ. Phải nhớ riêng
        // ở đây, nếu lấy từ item.photos thì ảnh vừa xoá sẽ bị giữ lại mãi.
        legacyPhotos = new Map();
        meterData.forEach(it => {
            if (it.photos && it.photos.length) legacyPhotos.set(it.id, it.photos);
        });
        attachPhotos();
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

    // Ảnh nghe riêng: mỗi ảnh là một bản ghi nên thêm/xoá ảnh không bao giờ
    // đụng vào bản ghi công tơ, hai người chụp cùng lúc không mất ảnh của nhau
    unsubPhotos = photosCol().onSnapshot(snap => {
        cloudPhotos = snap.docs.map(d => d.data());
        attachPhotos();
    }, () => {});
}

function stopListening() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubPhotos) { unsubPhotos(); unsubPhotos = null; }
}

/* Gắn ảnh từ collection riêng vào từng công tơ để hiển thị.
   Ảnh cũ còn nhúng trong bản ghi công tơ (bản app trước) vẫn hiện bình thường. */
function attachPhotos() {
    const byMeter = new Map();
    cloudPhotos.forEach(p => {
        if (!p || !p.meterId) return;
        if (!byMeter.has(p.meterId)) byMeter.set(p.meterId, []);
        byMeter.get(p.meterId).push(p);
    });

    meterData.forEach(item => {
        const legacy = legacyPhotos.get(item.id) || [];
        const fresh = (byMeter.get(item.id) || []).slice()
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const seen = new Set(fresh.map(p => p.id));
        item.photos = legacy.filter(p => !seen.has(p.id)).concat(fresh);
    });

    saveLocal();
    renderList();
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
        items.slice(i, i + 400).forEach(it =>
            batch.set(metersCol().doc(it.id), meterDoc(it), { merge: true }));
        await batch.commit();
    }
}

/* Import gop chi duoc phep sua may truong mo ta, khong dung toi phan da lam */
const IMPORT_FIELDS = ['stt', 'soCongToXuong', 'soCongToLen', 'diaChi', 'maTram', 'tenTram', 'phone'];

async function writeImportPatches(items) {
    for (let i = 0; i < items.length; i += 400) {
        const batch = db.batch();
        items.slice(i, i + 400).forEach(it => {
            const patch = { updatedAt: it.updatedAt || Date.now(), updatedBy: it.updatedBy || '' };
            IMPORT_FIELDS.forEach(f => { patch[f] = it[f]; });
            batch.set(metersCol().doc(it.id), patch, { merge: true });
        });
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
    updateWhoAmI();
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
/* Bản ghi công tơ đẩy lên nhóm — ảnh nằm ở collection riêng nên bỏ ra */
function meterDoc(item) {
    const d = Object.assign({}, item);
    delete d.photos;
    return d;
}

/* Lưu thay đổi.
   `fields` là danh sách trường thực sự vừa đổi. Chỉ ghi đúng mấy trường đó lên
   Firestore (set + merge) nên hai người sửa hai thứ khác nhau trên cùng một
   công tơ sẽ không đạp lên nhau. Không truyền `fields` thì ghi cả bản ghi —
   chỉ dùng lúc import. */
function persist(item, fields) {
    item.updatedAt = Date.now();
    if (userName) item.updatedBy = userName;
    saveLocal();
    if (!cloudReady) return;

    let payload;
    if (fields && fields.length) {
        payload = { updatedAt: item.updatedAt, updatedBy: item.updatedBy || '' };
        fields.forEach(f => { payload[f] = item[f]; });
    } else {
        payload = meterDoc(item);
    }
    metersCol().doc(item.id).set(payload, { merge: true })
        .catch(e => toast('⚠️ Lỗi lưu lên nhóm: ' + e.message));
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
/* `skip` là những cột đã bị ô chọn khác lấy mất — tránh hai ô cùng trỏ 1 cột */
function findHeader(headers, candidates, skip) {
    const free = headers.filter(h => !(skip || []).includes(h));
    for (const c of candidates) {
        const found = free.find(h => h === c || norm(h) === norm(c));
        if (found) return found;
    }
    for (const c of candidates) {
        const nc = norm(c);
        if (!nc) continue;
        const found = free.find(h => norm(h) && (norm(h).includes(nc) || nc.includes(norm(h))));
        if (found) return found;
    }
    return '';
}

/* Từ khoá để nhận ra đâu là dòng tên cột thật */
const HEADER_HINTS = ['cong to', 'no moi', 'no cu', 'dia chi', 'ma tram', 'ten khach hang',
                      'ma diem do', 'stt', 'so dien thoai', 'ten tram'];

/* Nhiều file bắt đầu bằng một dòng tiêu đề gộp ô ("ĐỨC DIỄN 10 --- 121 CÔNG TƠ"),
   tên cột thật nằm ở dòng 2 (hoặc dòng 3). Dò xem dòng nào mới là dòng tên cột:
   dòng có nhiều ô và trùng nhiều từ khoá nhất. */
function detectHeaderRow(matrix) {
    let best = 0, bestScore = -1;
    const look = Math.min(matrix.length, 15);
    for (let i = 0; i < look; i++) {
        const cells = (matrix[i] || []).map(c => String(c ?? '').trim()).filter(c => c !== '');
        if (cells.length < 2) continue;          // dòng tiêu đề gộp ô chỉ có 1 ô
        let score = cells.length;
        cells.forEach(c => {
            if (HEADER_HINTS.some(h => norm(c).includes(norm(h)))) score += 10;
        });
        if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
}

/* Tên cột: bỏ khoảng trắng thừa, ô trống thì đặt tên theo chữ cái cột, trùng thì đánh số */
function buildHeaders(row) {
    const headers = [];
    (row || []).forEach((cell, i) => {
        const base = String(cell ?? '').trim() || ('Cột ' + XLSX.utils.encode_col(i));
        let name = base, k = 2;
        while (headers.includes(name)) name = base + ' (' + (k++) + ')';
        headers.push(name);
    });
    return headers;
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

            // Đọc thô cả bảng để tự tìm dòng tên cột, không mặc định là dòng 1
            const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });
            if (!matrix.length) {
                alert('File Excel trống!');
                return;
            }

            const hIdx = detectHeaderRow(matrix);
            excelHeaders = buildHeaders(matrix[hIdx]);
            excelRows = matrix.slice(hIdx + 1)
                .map(r => {
                    const o = {};
                    excelHeaders.forEach((h, i) => { o[h] = (r || [])[i] ?? ''; });
                    return o;
                })
                .filter(o => excelHeaders.some(h => String(o[h]).trim() !== ''));

            if (excelRows.length === 0) {
                alert('File Excel không có dòng dữ liệu nào!');
                return;
            }

            document.getElementById('mapPanel').style.display = 'block';

            // Đoán cột "công tơ mới" trước, rồi mới tới công tơ cũ — nếu làm ngược,
            // chữ "Công tơ" sẽ khớp luôn vào cột "Công tơ mới"
            const gLen    = findHeader(excelHeaders, ['NO MOI', 'no mới', 'no moi', 'công tơ mới',
                                                      'cong to moi', 'Công tơ mới', 'công tơ lên',
                                                      'ct mới', 'no công tơ lên']);
            const gXuong  = findHeader(excelHeaders, ['Công tơ', 'cong to', 'công tơ', 'no cũ',
                                                      'công tơ cũ', 'cong to cu', 'công tơ xuống',
                                                      'no công tơ xuống'], [gLen]);
            const taken   = [gLen, gXuong];
            const gDiaChi = findHeader(excelHeaders, ['Địa chỉ', 'dia chi', 'Địa chỉ sử dụng điện', 'dia chi su dung dien'], taken);
            taken.push(gDiaChi);
            const gPhone  = findHeader(excelHeaders, ['SĐT', 'Số điện thoại', 'sdt', 'dienthoai', 'phone', 'Điện thoại', 'dien thoai', 'Tel', 'Mobile', 'Số DT', 'so dt', 'SĐT KH', 'sdt kh'], taken);
            taken.push(gPhone);
            const gMaTram = findHeader(excelHeaders, ['Mã trạm', 'ma tram', 'matram'], taken);
            taken.push(gMaTram);
            const gTenTram= findHeader(excelHeaders, ['Tên khách hàng', 'ten khach hang', 'Tên trạm', 'ten tram'], taken);
            taken.push(gTenTram);
            const gSTT    = findHeader(excelHeaders, ['số thứ tự', 'so thu tu', 'STT', 'stt'], taken);

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
    const newItems = [], updatedItems = [];

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
            if (userName) exist.updatedBy = userName;
            updatedItems.push(exist);
        } else {
            const item = normalizeItem(Object.assign({ id: uid(), order: nextOrder++ }, row));
            if (userName) item.updatedBy = userName;
            item.updatedAt = Date.now();
            meterData.push(item);
            if (k) index.set(k, item);
            newItems.push(item);
        }
    });

    saveLocal();
    renderList();
    return {
        added: newItems.length,
        updated: updatedItems.length,
        newItems, updatedItems,
        touched: newItems.concat(updatedItems)
    };
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
            await writeBatched(r.newItems);
            // Dong da co thi chi sua may truong mo ta, khong dung toi
            // trang thai da thay / ghi chu ma nguoi khac vua cap nhat
            await writeImportPatches(r.updatedItems);
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
    persist(item, ['done', 'time']);
    renderList();
}

function updateNote(id, value) {
    const item = byId(id);
    if (!item) return;
    item.note = value;
    persist(item, ['note']);
}

function updatePhone(id, value) {
    const item = byId(id);
    if (!item) return;
    item.phone = normalizePhone(value);
    persist(item, ['phone']);
    renderList();
}

async function deleteItem(id) {
    const item = byId(id);
    if (!item) return;
    if (!confirm('Xóa công tơ này' + (item.photos.length ? ' và ' + item.photos.length + ' ảnh' : '') + '?')) return;

    for (const p of item.photos) await removePhotoData(p);
    meterData = meterData.filter(m => m.id !== id);
    cloudPhotos = cloudPhotos.filter(p => p.meterId !== id);
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
            const meta = {
                id: photoId, meterId: item.id, thumb: thumb, time: nowStr(),
                by: userName || '', device: deviceId, pending: true, createdAt: Date.now()
            };

            if (cloudReady) {
                // Mỗi ảnh là một bản ghi riêng, thêm ảnh không đụng gì tới bản
                // ghi công tơ nên không sợ đè lên thay đổi của người khác
                await photosCol().doc(photoId).set(meta);
            } else {
                item.photos.push(meta);
                saveLocal();
            }
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

/* Lưu thay đổi của riêng một tấm ảnh — chỉ ghi đúng mấy trường vừa đổi,
   không đụng tới bản ghi công tơ lẫn các ảnh khác. */
function savePhotoMeta(item, meta, fields) {
    if (cloudReady) {
        const patch = {};
        fields.forEach(f => { if (meta[f] !== undefined) patch[f] = meta[f]; });
        photosCol().doc(meta.id).set(patch, { merge: true }).catch(() => {});
    }
    saveLocal();
}

/* Đẩy nốt những ảnh còn đang chờ (chụp lúc mất sóng) */
async function uploadPending() {
    if (uploading || !cloudinaryConfigured() || !navigator.onLine) return;
    uploading = true;
    try {
        for (const item of meterData.slice()) {
            // Chỉ máy đã chụp mới có file gốc để đẩy lên. Máy khác trong nhóm
            // cũng thấy ảnh đang chờ nhưng phải để yên, không thì sẽ đánh dấu
            // nhầm là hỏng và ảnh không bao giờ được tải lên.
            const mine = item.photos.filter(p => p.pending && p.device === deviceId);

            for (const meta of mine) {
                const data = await PhotoStore.get(meta.id);
                if (!data) {
                    meta.pending = false;
                    meta.missing = true;
                    savePhotoMeta(item, meta, ['pending', 'missing']);
                    continue;
                }
                try {
                    const r = await uploadToCloudinary(meta.id, data, item);
                    meta.url = r.secure_url;
                    meta.publicId = r.public_id;
                    if (r.delete_token) { meta.deleteToken = r.delete_token; meta.deleteTokenAt = Date.now(); }
                    meta.pending = false;
                    savePhotoMeta(item, meta,
                        ['url', 'publicId', 'deleteToken', 'deleteTokenAt', 'pending']);
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
    saveLocal();
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
    if (fromUrl) teamCode = cleanTeamCode(fromUrl);

    document.getElementById('cameraInput').onchange = function (e) {
        handlePhotoFiles(Array.from(e.target.files)); e.target.value = '';
    };
    document.getElementById('galleryInput').onchange = function (e) {
        handlePhotoFiles(Array.from(e.target.files)); e.target.value = '';
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
    document.getElementById('nameInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveName(); }
    });
    document.getElementById('userInput').onchange = function () {
        if (!this.value.trim()) {       // khong cho xoa trang ten da co
            this.value = userName;
            toast('Phải có tên để anh em biết ai làm phần nào');
            return;
        }
        setUserName(this.value);
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

    requireName();      // lan dau mo app la hoi ten luon
    uploadPending();
})();
