/*
 * Thông báo khi số pin tại trạm đổi pin VinFast / V-Green thay đổi — script cho Shadowrocket.
 *
 * Script này chạy ở 2 chế độ:
 *  - http-response (MitM escooter-api.vinfast.vn): khi mở bản đồ trạm trong app, lưu lại URL + header
 *    (token) của request "battery-swap-stations/near" vào $persistentStore.
 *  - cron: định kỳ gọi lại request đó, so sánh số pin từng trạm với lần trước, có thay đổi thì đẩy thông báo.
 *
 * Tham số (argument, dạng key=value nối bằng &):
 *  - lat, lng, distance : cố định vị trí tìm trạm (mặc định lấy theo URL bắt được từ app)
 *  - top                : số trạm gần nhất cần theo dõi (mặc định 5)
 *  - names              : một phần tên/địa chỉ trạm cần theo dõi, ngăn cách bằng | — không phân biệt hoa thường,
 *                         có dấu hay không dấu (ưu tiên hơn top). Vd: names=le loi|nguyen hue
 *  - ids                : danh sách id trạm cần theo dõi, ngăn cách bằng | (ưu tiên hơn names, top)
 *  - fields            : các field số pin cần so sánh, ngăn cách bằng | (mặc định tự dò)
 *  - debug=1            : thông báo cấu trúc dữ liệu dò được (dùng khi cấu hình lần đầu)
 */

const KEY_REQ = 'vfswap.req';
const KEY_SNAP = 'vfswap.snap';
const KEY_AUTH_ALERT = 'vfswap.authAlert';
const KEY_SAMPLE = 'vfswap.sample';
const KEY_FILTER_ALERT = 'vfswap.filterAlert';

const TITLE = '🔋 Trạm đổi pin';
const DROP_HEADERS = /^(:|content-length$|connection$|host$|accept-encoding$)/i;
const ID_KEYS = ['id', 'stationId', 'station_id', 'stationCode', 'code', 'uuid'];
const NAME_KEYS = ['name', 'stationName', 'station_name', 'displayName', 'title', 'address'];
const DIST_KEYS = ['distance', 'distanceKm', 'distance_km', 'dist'];
const BATT_RE = /batt|pin|avail|full|charg|ready|slot|empty|swap|qty|quantity|count|total|num|stock/i;
const SKIP_RE = /lat|lng|lon|dist|^id$|id$|phone|time|date|price|fee|type|code|status$|rating|zoom/i;

const args = parseArgs(typeof $argument === 'string' ? $argument : '');

if (typeof $request !== 'undefined') {
    capture();
} else {
    poll();
}

function capture() {
    const prev = readJson(KEY_REQ);
    const headers = {};
    Object.keys($request.headers || {}).forEach((k) => {
        if (!DROP_HEADERS.test(k)) headers[k] = $request.headers[k];
    });
    const auth = authOf(headers);
    $persistentStore.write(JSON.stringify({ url: $request.url, headers, savedAt: Date.now() }), KEY_REQ);
    if (typeof $response !== 'undefined' && $response.body) {
        $persistentStore.write(String($response.body).slice(0, 20000), KEY_SAMPLE);
    }
    $persistentStore.write('', KEY_AUTH_ALERT);
    if (!prev || authOf(prev.headers) !== auth) {
        $notification.post(TITLE, 'Đã lưu phiên đăng nhập', 'Script sẽ tự kiểm tra số pin định kỳ.');
    }
    $done({});
}

function poll() {
    const saved = readJson(KEY_REQ);
    if (!saved) {
        alertOnce('Chưa có token', 'Mở app VinFast → bản đồ trạm đổi pin một lần để script lấy token.');
        return $done();
    }
    const url = buildUrl(saved.url);
    $httpClient.get({ url, headers: saved.headers, timeout: 20 }, (err, resp, body) => {
        try {
            handle(err, resp, body);
        } catch (e) {
            console.log('[vf-swap] lỗi: ' + e);
        }
        $done();
    });
}

function handle(err, resp, body) {
    if (err) {
        console.log('[vf-swap] request lỗi: ' + err);
        return;
    }
    const status = resp && (resp.status || resp.statusCode);
    let json = null;
    try {
        json = JSON.parse(body);
    } catch (e) {
        // Cloudflare challenge hoặc lỗi server trả HTML
    }
    if (isAuthError(status, json)) {
        alertOnce('Token hết hạn', 'Mở app VinFast → bản đồ trạm đổi pin để làm mới token.');
        return;
    }
    if (!json || status >= 400) {
        console.log('[vf-swap] HTTP ' + status + ': ' + String(body).slice(0, 300));
        return;
    }
    $persistentStore.write('', KEY_AUTH_ALERT);

    const all = sortByDistance(findStations(json.data !== undefined ? json.data : json));
    if (!all.length) {
        if (args.debug) $notification.post(TITLE, 'Không dò được danh sách trạm', String(body).slice(0, 300));
        return;
    }
    const watched = pickStations(all);
    if (!watched.length) {
        // Báo 1 lần cho mỗi bộ lọc, kèm tên các trạm gần nhất để dễ chọn lại
        const filter = args.ids || args.names;
        if ($persistentStore.read(KEY_FILTER_ALERT) !== filter) {
            $persistentStore.write(filter, KEY_FILTER_ALERT);
            const nearest = all.slice(0, 5).map((st) => '• ' + pick(st, NAME_KEYS)).join('\n');
            $notification.post(TITLE, 'Không có trạm nào khớp: ' + filter, 'Trạm gần nhất:\n' + nearest);
        }
        return;
    }
    $persistentStore.write('', KEY_FILTER_ALERT);
    const fieldList = args.fields ? args.fields.split('|') : null;
    const prevSnap = readJson(KEY_SNAP) || {};
    const nextSnap = {};
    const added = [];
    const changed = [];

    watched.forEach((st) => {
        const id = String(pick(st, ID_KEYS) || pick(st, NAME_KEYS));
        const name = String(pick(st, NAME_KEYS) || id);
        const vals = fieldList ? pickFields(st, fieldList) : batteryFields(st, '', 0);
        nextSnap[id] = { name, vals };
        const old = prevSnap[id];
        if (!old) {
            added.push(name + ': ' + fmtVals(vals));
        } else {
            const diff = diffVals(old.vals, vals);
            if (diff) changed.push(name + ': ' + diff);
        }
    });
    $persistentStore.write(JSON.stringify(nextSnap), KEY_SNAP);

    if (args.debug) {
        $notification.post(TITLE, 'Debug: field của trạm đầu tiên', Object.keys(watched[0]).join(', '));
    }
    if (changed.length) {
        $notification.post(TITLE, changed.length + ' trạm thay đổi', changed.slice(0, 8).join('\n'));
    }
    if (added.length) {
        $notification.post(TITLE, 'Bắt đầu theo dõi ' + added.length + ' trạm', added.slice(0, 8).join('\n'));
    }
}

function sortByDistance(list) {
    const sorted = list.slice();
    if (sorted.length && pick(sorted[0], DIST_KEYS) !== undefined) {
        sorted.sort((a, b) => parseFloat(pick(a, DIST_KEYS)) - parseFloat(pick(b, DIST_KEYS)));
    }
    return sorted;
}

function pickStations(all) {
    if (args.ids) {
        const ids = args.ids.split('|');
        return all.filter((st) => ids.indexOf(String(pick(st, ID_KEYS))) >= 0);
    }
    if (args.names) {
        const names = args.names.split('|').map(norm).filter(Boolean);
        return all.filter((st) => {
            const text = norm(NAME_KEYS.map((k) => st[k] || '').join(' '));
            return names.some((n) => text.indexOf(n) >= 0);
        });
    }
    return all.slice(0, Number(args.top) || 5);
}

// Bỏ dấu tiếng Việt + chữ thường để so khớp tên trạm
function norm(s) {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tìm mảng object lớn nhất trong response — coi đó là danh sách trạm
function findStations(node) {
    let best = [];
    const queue = [node];
    while (queue.length) {
        const cur = queue.shift();
        if (Array.isArray(cur)) {
            const objs = cur.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
            if (objs.length > best.length && objs.some((x) => pick(x, ID_KEYS) !== undefined || pick(x, NAME_KEYS) !== undefined)) {
                best = objs;
            }
        } else if (cur && typeof cur === 'object') {
            Object.keys(cur).forEach((k) => queue.push(cur[k]));
        }
    }
    return best;
}

// Dò các field số liên quan đến pin (đệ quy 2 cấp); mảng slot/khay thì đếm theo trạng thái
function batteryFields(obj, prefix, depth) {
    const out = {};
    Object.keys(obj).forEach((k) => {
        const v = obj[k];
        const key = prefix + k;
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(v))) {
            if (BATT_RE.test(k) && !SKIP_RE.test(k)) out[key] = Number(v);
        } else if (Array.isArray(v)) {
            if (BATT_RE.test(k) && v.length && typeof v[0] === 'object') {
                v.forEach((item) => {
                    const s = item && (item.status || item.state || item.batteryStatus);
                    if (s !== undefined) out[key + '.' + s] = (out[key + '.' + s] || 0) + 1;
                });
            }
        } else if (v && typeof v === 'object' && depth < 2) {
            Object.assign(out, batteryFields(v, key + '.', depth + 1));
        }
    });
    return out;
}

function pickFields(obj, paths) {
    const out = {};
    paths.forEach((p) => {
        const v = p.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
        if (v !== undefined) out[p] = v;
    });
    return out;
}

function diffVals(a, b) {
    a = a || {};
    const keys = Object.keys(Object.assign({}, a, b));
    const parts = keys.filter((k) => a[k] !== b[k]).map((k) => k + ' ' + fmt(a[k]) + '→' + fmt(b[k]));
    return parts.join(', ');
}

function fmtVals(vals) {
    const keys = Object.keys(vals);
    return keys.length ? keys.map((k) => k + '=' + vals[k]).join(', ') : '(không dò được field pin, bật debug=1)';
}

function fmt(v) {
    return v === undefined ? '∅' : String(v);
}

function buildUrl(url) {
    ['lat', 'lng', 'distance'].forEach((k) => {
        if (!args[k]) return;
        const re = new RegExp('([?&]' + k + '=)[^&]*');
        url = re.test(url) ? url.replace(re, '$1' + args[k]) : url + (url.indexOf('?') >= 0 ? '&' : '?') + k + '=' + args[k];
    });
    return url;
}

function isAuthError(status, json) {
    if (status === 401 || status === 403) return true;
    const st = json && json.status;
    if (!st || typeof st !== 'object') return false;
    return /^0210/.test(String(st.code)) || /xác thực|token|unauthor|oauth/i.test(String(st.message) + ' ' + String(st.description));
}

function alertOnce(subtitle, body) {
    if ($persistentStore.read(KEY_AUTH_ALERT) === subtitle) return;
    $persistentStore.write(subtitle, KEY_AUTH_ALERT);
    $notification.post(TITLE, subtitle, body);
}

function authOf(headers) {
    if (!headers) return '';
    const k = Object.keys(headers).find((h) => /^authorization$/i.test(h));
    return k ? headers[k] : '';
}

function pick(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
        if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return undefined;
}

function readJson(key) {
    try {
        return JSON.parse($persistentStore.read(key) || 'null');
    } catch (e) {
        return null;
    }
}

function parseArgs(s) {
    const out = {};
    s.trim().replace(/^"|"$/g, '').split('&').forEach((pair) => {
        const i = pair.indexOf('=');
        if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    });
    return out;
}
