let meterData = JSON.parse(localStorage.getItem('meterData') || '[]');
let currentFilter = 'all';
let excelRows = [];
let excelHeaders = [];

function saveData() {
    localStorage.setItem('meterData', JSON.stringify(meterData));
}

function escapeHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function norm(str) {
    return String(str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]/g,'');
}

function normalizePhone(phone) {
    return String(phone||'').replace(/[^0-9+]/g,'');
}

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

            const gXuong  = findHeader(excelHeaders, ['công tơ mới', 'cong to moi', 'Công tơ mới', 'no mới']);
            const gLen    = findHeader(excelHeaders, ['Công tơ', 'cong to', 'công tơ']);
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

function doImport() {
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

    if (meterData.length > 0) {
        if (!confirm('Đang có ' + meterData.length + ' dữ liệu cũ. Xóa hết rồi import mới?')) {
            return;
        }
        meterData = [];
    }

    let added = 0;

    excelRows.forEach((row, idx) => {
        const xuongStr  = colXuong  ? String(row[colXuong]  || '').trim() : '';
        const lenStr    = colLen    ? String(row[colLen]    || '').trim() : '';
        const diaChiStr = colDiaChi ? String(row[colDiaChi] || '').trim() : '';
        const phoneStr  = colPhone  ? normalizePhone(row[colPhone]) : '';
        const maTramStr = colMaTram ? String(row[colMaTram] || '').trim() : '';
        const tenTramStr= colTenTram? String(row[colTenTram]|| '').trim() : '';
        const sttStr    = colSTT    ? String(row[colSTT]    || '').trim() : String(idx + 1);

        if (!xuongStr && !lenStr) return;

        meterData.push({
            stt: sttStr,
            soCongToXuong: xuongStr,
            soCongToLen: lenStr,
            diaChi: diaChiStr,
            phone: phoneStr,
            maTram: maTramStr,
            tenTram: tenTramStr,
            done: false,
            time: null,
            note: ''
        });
        added++;
    });

    saveData();
    renderList();
    document.getElementById('mapPanel').style.display = 'none';
    alert('✅ Đã import thành công ' + added + ' công tơ');
}

function setFilter(f) {
    currentFilter = f;
    document.getElementById('btnAll').className = 'filter-btn' + (f==='all'?' active-all':'');
    document.getElementById('btnPending').className = 'filter-btn' + (f==='pending'?' active-pending':'');
    document.getElementById('btnDone').className = 'filter-btn' + (f==='done'?' active-done':'');
    renderList();
}

function toggleDone(index) {
    meterData[index].done = !meterData[index].done;
    meterData[index].time = new Date().toLocaleString('vi-VN');
    saveData();
    renderList();
}

function updateNote(index, value) {
    meterData[index].note = value;
    saveData();
}

function updatePhone(index, value) {
    meterData[index].phone = normalizePhone(value);
    saveData();
    renderList();
}

function deleteItem(index) {
    if (confirm('Xóa công tơ này?')) {
        meterData.splice(index, 1);
        saveData();
        renderList();
    }
}

function clearAll() {
    if (confirm('Xóa toàn bộ dữ liệu?')) {
        meterData = [];
        saveData();
        renderList();
    }
}

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
        if (currentFilter === 'done') return item.done;
        return true;
    });

    filtered.forEach(item => {
        const i = meterData.indexOf(item);
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
                       onchange="updatePhone(${i}, this.value)"
                       onclick="this.select()">
                ${hasPhone ? `
                <div class="phone-actions">
                    <a class="call-btn" href="tel:${escapeHtml(phoneVal)}">📲 Gọi ngay</a>
                    <a class="sms-btn" href="sms:${escapeHtml(phoneVal)}">💬 Nhắn tin</a>
                </div>` : `<div style="margin-top:8px;font-size:13px;color:#888">Nhập số rồi nhấn ra ngoài để lưu</div>`}
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
            <div>
                <span class="status ${item.done?'done':'not-done'}" onclick="toggleDone(${i})">
                    ${item.done ? '✓ ĐÃ THAY' : '✗ CHƯA THAY'}
                </span>
            </div>
            ${item.time ? `<div style="margin-top:6px;font-size:12px;color:#888">⏱ ${escapeHtml(item.time)}</div>` : ''}
            <textarea placeholder="📝 Ghi chú..." onchange="updateNote(${i},this.value)">${escapeHtml(item.note)}</textarea>
            <div class="row">
                <button class="danger" onclick="deleteItem(${i})">🗑 Xóa</button>
            </div>
        `;
        list.appendChild(div);
    });

    const doneCount = meterData.filter(m => m.done).length;
    document.getElementById('counter').innerHTML = `
        Tổng: <b>${meterData.length}</b>
        &nbsp;|&nbsp; <span style="color:#34c759">Đã thay: <b>${doneCount}</b></span>
        &nbsp;|&nbsp; <span style="color:#ff3b30">Chưa thay: <b>${meterData.length - doneCount}</b></span>
    `;
}

renderList();
