// @ts-nocheck
/**
 * 桃子取回 — 五步：
 * 1) 识别自定义 URL 白名单
 * 2) 标记随请求体出发 + 发光
 * 3) 等 sub 在流里主动回传 peach_st_reclaim；假断后带密钥问三态（空/正在收/收完）
 * 4) 填栏、熄光、倒计时、亮手（正在收则续发光等号码牌对应任务完成）
 * 5) 点手凭 claim_token 取回，saveReply 入泡
 */
import { getContext } from '../../../st-context.js';
import { SECRET_KEYS, findSecret } from '../../../secrets.js';

const BODY_MARKER_LINE = 'peach_st_client: 1';
const HEADER_LINE = 'X-Peach-ST-Client: 1';
const FLOAT_ID = 'peach-st-cache-float';
const POS_KEY = 'peach-st-cache-float-pos';
const VIS_KEY = 'peach-st-cache-float-visible';
/** 可选：插件内优先密钥；空则回退酒馆自定义栏/密钥库 */
const API_KEY_OVERRIDE_KEY = 'peach-st-cache-api-key-override';
const MENU_ID = 'peach_st_cache_menu_item';
const SETTINGS_HINT =
    '仅限桃子站请求可用，如果一次发送会同时触发多次属于桃子站的请求请在插件内额外添加key';
/** 同一次连发里非桃子与桃子交错：等一会再决定报不报 */
const NON_PEACH_BURST_MS = 1500;
const DRAG_THRESHOLD_PX = 8;
/** 按住超过此时长才「允许拖」；未真拖过松手仍展开 */
const LONG_PRESS_MS = 280;
/** idle | running — 跟发送/停止同态；只有 running 时点停止才发真中断令 */
const GEN_IDLE = 'idle';
const GEN_RUNNING = 'running';
const ALLOWED_BASES = [
    'https://54bbm.54-bbm.win',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
];
const NON_PEACH_MSG = '非桃子站无法使用，请关闭插件';

const ICON_FIST = new URL('./icons/fist.svg', import.meta.url).href;
const ICON_TAO = new URL('./icons/tao-unit.png', import.meta.url).href;
const ICON_TAOHE = new URL('./icons/taoh.png', import.meta.url).href;

/** @type {object|null} */
let lastSignal = null;
let claimToken = '';
let countdownTimer = null;
let expiresAtMs = 0;
let claiming = false;
let panelOpen = false;
let floatVisible = loadFloatVisible();
/** 已识别白名单并真正发出带标记的请求，等 sub 回传 */
let waitingBackend = false;
let urlOkLogged = false;
let dragBound = false;
let suppressClick = false;
/** 本页初始化后最多提醒一次「非桃子站」 */
let nonPeachWarned = false;
/** 本局是否已见过桃子站请求；见过则整局不再报非桃子 */
let sessionSawPeach = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let nonPeachPendingTimer = null;
let hooksBound = false;
let fetchPatched = false;
/** @type {'idle'|'running'} */
let genState = GEN_IDLE;
/** 本轮生成号；真中断令带它；卸载/刷新不发令 → 中转不停 */
let activeRequestId = '';
/** 防抖：进角色/就绪后补问缓存 */
let cachePollTimer = null;
let cachePollInFlight = false;

function toast(text, type = 'info') {
    try {
        toastr?.[type]?.(text) ?? console.log(`[peach-st-cache] ${text}`);
    } catch {
        console.log(`[peach-st-cache] ${text}`);
    }
}

function loadFloatVisible() {
    try {
        const raw = localStorage.getItem(VIS_KEY);
        if (raw === null || raw === undefined || raw === '') return true;
        return raw === '1' || raw === 'true';
    } catch {
        return true;
    }
}

function saveFloatVisible(v) {
    floatVisible = !!v;
    try {
        localStorage.setItem(VIS_KEY, floatVisible ? '1' : '0');
    } catch {
        /* ignore */
    }
}

function normalizeBaseUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/v1$/i, '');
    return u;
}

function getCustomEndpoint() {
    const ctx = getContext();
    const settings = ctx.chatCompletionSettings || {};
    return {
        source: settings.chat_completion_source,
        baseUrl: normalizeBaseUrl(settings.custom_url),
        rawUrl: String(settings.custom_url || '').trim(),
    };
}

/**
 * 仅发请求时用：只看本包携带的 custom_url。
 * 启动/显隐/复位/补问 —— 一律不做站别判断、不报错。
 */
function isPeachRequestUrl(generate_data) {
    const raw = String(generate_data?.custom_url || '').trim();
    if (!raw) return false;
    const lower = normalizeBaseUrl(raw).toLowerCase();
    return ALLOWED_BASES.some((b) => lower === b.toLowerCase());
}

function notePeachRequestSeen() {
    sessionSawPeach = true;
    if (nonPeachPendingTimer) {
        clearTimeout(nonPeachPendingTimer);
        nonPeachPendingTimer = null;
    }
}

/**
 * 非桃子：不立刻吼。同一次发送里若稍后还有桃子站请求则作废；
 * 本局已见过桃子 / 已提醒过 → 永不报。
 */
function scheduleMaybeWarnNonPeach() {
    if (nonPeachWarned || sessionSawPeach) return;
    if (nonPeachPendingTimer) return;
    nonPeachPendingTimer = setTimeout(() => {
        nonPeachPendingTimer = null;
        if (nonPeachWarned || sessionSawPeach) return;
        nonPeachWarned = true;
        toast(NON_PEACH_MSG, 'warning');
    }, NON_PEACH_BURST_MS);
}

function loadApiKeyOverride() {
    try {
        return String(localStorage.getItem(API_KEY_OVERRIDE_KEY) || '').trim();
    } catch {
        return '';
    }
}

function saveApiKeyOverride(raw) {
    const v = String(raw || '').trim();
    try {
        if (v) localStorage.setItem(API_KEY_OVERRIDE_KEY, v);
        else localStorage.removeItem(API_KEY_OVERRIDE_KEY);
    } catch { /* ignore */ }
    return v;
}

function injectYamlLine(raw, line) {
    const text = String(raw || '');
    const key = line.split(':')[0].trim().toLowerCase();
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`${key}:`));
    if (idx >= 0) {
        lines[idx] = line;
        return lines.join('\n');
    }
    return text.trim() ? `${text.replace(/\s+$/, '')}\n${line}` : line;
}

function stripYamlKey(raw, keyLower) {
    return String(raw || '')
        .split(/\r?\n/)
        .filter((l) => !l.trim().toLowerCase().startsWith(`${keyLower}:`))
        .join('\n')
        .replace(/\n+$/, '');
}

function newPeachRequestId() {
    try {
        if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    } catch { /* ignore */ }
    const a = new Uint8Array(16);
    try { crypto.getRandomValues(a); } catch {
        for (let i = 0; i < 16; i++) a[i] = (Math.random() * 256) | 0;
    }
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setGenState(next) {
    genState = next === GEN_RUNNING ? GEN_RUNNING : GEN_IDLE;
    renderFloat();
}

/** 仅用户点停止时调用：向中转发真中断令。刷新/卸载不会走这里。 */
async function sendTrueAbort() {
    const id = String(activeRequestId || '').trim();
    if (!id) return;
    const { baseUrl } = getCustomEndpoint();
    if (!baseUrl) return;
    try {
        await fetch(`${baseUrl}/v1/peach-st/abort`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peach_st_request_id: id }),
            keepalive: true,
        });
        console.log('[peach-st-cache] true abort sent', id.slice(0, 8));
    } catch (e) {
        console.warn('[peach-st-cache] true abort failed', e);
    }
}

function onUserStopGeneration() {
    // 真中断：先发令再清本地态；没发令（例如卸扩展）中转不会停
    void sendTrueAbort();
    setGenState(GEN_IDLE);
}

function onGenerationEndedNormally() {
    setGenState(GEN_IDLE);
    // 正常收完：不发中断令
}

function isInActiveChat() {
    try {
        const ctx = getContext();
        if (ctx.getCurrentChatId?.()) return true;
        if (ctx.characterId != null && ctx.characterId !== '') return true;
        if (ctx.groupId) return true;
        if (ctx.chatId) return true;
    } catch { /* ignore */ }
    return false;
}

/**
 * 取回/补问用密钥：插件内可选优先；空则回退酒馆自定义栏 → 密钥库。
 */
async function getPeachApiKey() {
    const override = loadApiKeyOverride();
    if (override) return override;
    try {
        const fromInput = String($('#api_key_custom').val() || '').trim();
        // 排除遮罩占位
        if (fromInput && fromInput.length >= 8 && !/[•●*]/.test(fromInput)) {
            return fromInput;
        }
    } catch { /* ignore */ }
    try {
        const v = await findSecret(SECRET_KEYS.CUSTOM);
        if (v && String(v).trim()) return String(v).trim();
    } catch (e) {
        console.warn('[peach-st-cache] findSecret failed', e);
    }
    return '';
}

/** 假断/刷新后续问「正在收」：有相认牌就每隔一会再问，直到收完或空 */
let pendingWaitId = '';
let pendingPollTimer = null;

function stopPendingPoll() {
    if (pendingPollTimer != null) {
        clearTimeout(pendingPollTimer);
        pendingPollTimer = null;
    }
}

function schedulePendingPoll(reason = '', delayMs = 2000) {
    stopPendingPoll();
    pendingPollTimer = setTimeout(() => {
        pendingPollTimer = null;
        void pollCacheFromSub(reason || 'pending_wait');
    }, delayMs);
}

/**
 * 刷新/重进后：带密钥问中转三态——空 / 正在收 / 收完可取回。
 * 不抢启动——由 scheduleCachePoll 在就绪/进角色后调用。
 * 正在收：拿 request_id 当号码牌，发光续问；收完：走 onReclaimSignal 亮手。
 */
async function pollCacheFromSub(reason = '') {
    if (cachePollInFlight) return;
    // 本机生成流还在：主路径靠流里 peach_st_reclaim，不必抢问
    if (genState === GEN_RUNNING && !pendingWaitId) return;
    if (claimToken && lastSignal?.has_cache) {
        stopPendingPoll();
        return;
    }

    const { baseUrl } = getCustomEndpoint();
    if (!baseUrl) return;
    const key = await getPeachApiKey();
    if (!key) {
        console.log('[peach-st-cache] cache poll skip: no api key', reason);
        return;
    }

    cachePollInFlight = true;
    try {
        const res = await fetch(`${baseUrl}/v1/peach-st/cache`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok) {
            console.warn('[peach-st-cache] cache poll http', res.status, reason);
            return;
        }
        const st = await res.json();
        // 收完
        if (st?.has_cache && String(st.claim_token || '').trim()) {
            pendingWaitId = '';
            stopPendingPoll();
            onReclaimSignal({
                has_cache: true,
                claim_token: st.claim_token,
                remaining_seconds: st.remaining_seconds,
                expires_at: st.expires_at,
                prompt_tokens: st.prompt_tokens,
                completion_tokens: st.completion_tokens,
                cache_read_tokens: st.cache_read_tokens,
                cache_creation_tokens: st.cache_creation_tokens,
                actual_cost: st.actual_cost,
                peach_balance: st.peach_balance,
                taohe_balance: st.taohe_balance,
                has_peach_balance: st.has_peach_balance,
                has_taohe_balance: st.has_taohe_balance,
                request_id: st.request_id,
            });
            console.log('[peach-st-cache] cache poll ready, fist', reason);
            return;
        }
        // 正在收：号码牌 + 发光 + 续问
        if (st?.pending) {
            pendingWaitId = String(st.request_id || pendingWaitId || '').trim();
            waitingBackend = true;
            setGenState(GEN_IDLE);
            renderFloat();
            console.log('[peach-st-cache] cache poll pending plate', pendingWaitId.slice(0, 8), reason);
            schedulePendingPoll(reason, 2000);
            return;
        }
        // 空
        if (pendingWaitId) {
            console.log('[peach-st-cache] cache poll idle after wait', reason);
        }
        pendingWaitId = '';
        stopPendingPoll();
        if (waitingBackend && !claimToken) {
            waitingBackend = false;
            renderFloat();
        }
        console.log('[peach-st-cache] cache poll empty', reason);
    } catch (e) {
        console.warn('[peach-st-cache] cache poll failed', reason, e);
        if (pendingWaitId) schedulePendingPoll(reason, 3000);
    } finally {
        cachePollInFlight = false;
    }
}

/** 酒馆初始化后再蹦：进了角色/聊天才问，避开启动高峰 */
function scheduleCachePoll(reason = '', delayMs = 800) {
    if (cachePollTimer != null) {
        clearTimeout(cachePollTimer);
        cachePollTimer = null;
    }
    cachePollTimer = setTimeout(() => {
        cachePollTimer = null;
        if (!isInActiveChat()) {
            console.log('[peach-st-cache] cache poll wait chat', reason);
            return;
        }
        void pollCacheFromSub(reason);
    }, delayMs);
}

/** 仅在确认本包是桃子站之后写入设置（由发请求路径调用） */
function ensureMarkersInSettings() {
    const ctx = getContext();
    const settings = ctx.chatCompletionSettings;
    if (!settings) return false;
    settings.custom_include_body = injectYamlLine(settings.custom_include_body, BODY_MARKER_LINE);
    settings.custom_include_headers = injectYamlLine(settings.custom_include_headers, HEADER_LINE);
    const $body = $('#custom_include_body');
    if ($body.length) $body.val(settings.custom_include_body);
    const $hdr = $('#custom_include_headers');
    if ($hdr.length) $hdr.val(settings.custom_include_headers);
    return true;
}

function stripMarkersFromSettings() {
    const ctx = getContext();
    const settings = ctx.chatCompletionSettings;
    if (!settings) return;
    settings.custom_include_body = stripYamlKey(settings.custom_include_body, 'peach_st_client');
    settings.custom_include_body = stripYamlKey(settings.custom_include_body, 'peach_st_request_id');
    settings.custom_include_headers = stripYamlKey(settings.custom_include_headers, 'x-peach-st-client');
    settings.custom_include_headers = stripYamlKey(settings.custom_include_headers, 'x-peach-st-request-id');
    const $body = $('#custom_include_body');
    if ($body.length) $body.val(settings.custom_include_body);
    const $hdr = $('#custom_include_headers');
    if ($hdr.length) $hdr.val(settings.custom_include_headers);
}

/**
 * 步骤1+2：真正组好出站包时 — 唯一做站别判断的地方（本包 custom_url）。
 * 非桃子：只 toast，不藏悬浮条、不动显隐。
 */
function onChatCompletionSettingsReady(generate_data) {
    if (!generate_data || typeof generate_data !== 'object') return false;

    if (!isPeachRequestUrl(generate_data)) {
        // 可能同一次发送稍后还有桃子站请求：延后、且本局只提醒一次
        scheduleMaybeWarnNonPeach();
        waitingBackend = false;
        return false;
    }

    notePeachRequestSeen();

    if (!urlOkLogged) {
        urlOkLogged = true;
        console.log('[peach-st-cache] step1 url ok', normalizeBaseUrl(generate_data.custom_url));
    }

    // 步骤2：标记 + 本轮请求号随请求体出发（中转剥掉；假断不发中断令）
    activeRequestId = newPeachRequestId();
    generate_data.custom_include_body = injectYamlLine(generate_data.custom_include_body, BODY_MARKER_LINE);
    generate_data.custom_include_body = injectYamlLine(
        generate_data.custom_include_body,
        `peach_st_request_id: ${activeRequestId}`,
    );
    generate_data.custom_include_headers = injectYamlLine(generate_data.custom_include_headers, HEADER_LINE);
    generate_data.custom_include_headers = injectYamlLine(
        generate_data.custom_include_headers,
        `X-Peach-ST-Request-Id: ${activeRequestId}`,
    );
    ensureMarkersInSettings();

    waitingBackend = true;
    lastSignal = null;
    claimToken = '';
    stopCountdownTick();
    setGenState(GEN_RUNNING);
    console.log('[peach-st-cache] step2 marker+reqId, glow on', activeRequestId.slice(0, 8));
    return true;
}

/** 步骤3收：从流里看到 sub 主动推的 peach_st_reclaim */
function onReclaimSignal(sig) {
    if (!sig || typeof sig !== 'object') return;
    pendingWaitId = '';
    stopPendingPoll();
    lastSignal = sig;
    claimToken = String(sig.claim_token || '').trim();
    waitingBackend = false;
    setGenState(GEN_IDLE);

    if (sig.has_cache && Number(sig.remaining_seconds) > 0) {
        expiresAtMs = Date.now() + Number(sig.remaining_seconds) * 1000;
        startCountdownTick();
    } else if (sig.expires_at) {
        expiresAtMs = Number(sig.expires_at) * 1000;
        startCountdownTick();
    } else {
        expiresAtMs = 0;
        stopCountdownTick();
    }

    console.log('[peach-st-cache] step3/4 signal received', {
        has_cache: !!sig.has_cache,
        cost: sig.actual_cost,
        rem: sig.remaining_seconds,
        has_token: !!claimToken,
    });
    renderFloat();
}

function startCountdownTick() {
    stopCountdownTick();
    countdownTimer = setInterval(() => {
        renderFloat();
        if (expiresAtMs && Date.now() >= expiresAtMs) {
            if (lastSignal) {
                lastSignal.has_cache = false;
                lastSignal.remaining_seconds = 0;
            }
            claimToken = '';
            stopCountdownTick();
            renderFloat();
        }
    }, 1000);
}

function stopCountdownTick() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

/** 截获酒馆→本机中转的流，只读 peach_st_reclaim，不碰密钥 */
function patchFetchForReclaim() {
    if (fetchPatched) return;
    fetchPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
        const res = await orig(input, init);
        try {
            const url = typeof input === 'string' ? input : (input?.url || '');
            if (!String(url).includes('/api/backends/chat-completions/generate')) {
                return res;
            }
            if (!res.body || !res.ok) return res;
            const [tee1, tee2] = res.body.tee();
            void scanReclaimFromStream(tee2);
            return new Response(tee1, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
            });
        } catch (e) {
            console.warn('[peach-st-cache] fetch patch error', e);
            return res;
        }
    };
}

async function scanReclaimFromStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split(/\r\n\r\n|\n\n/);
            buf = parts.pop() || '';
            for (const chunk of parts) {
                const dataLines = chunk
                    .split(/\r?\n/)
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.replace(/^data:\s?/, ''))
                    .join('\n');
                if (!dataLines || dataLines === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(dataLines);
                    if (parsed && parsed.peach_st_reclaim) {
                        onReclaimSignal(parsed.peach_st_reclaim);
                    }
                } catch {
                    /* ignore non-json frames */
                }
            }
        }
    } catch (e) {
        console.warn('[peach-st-cache] stream scan ended', e);
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }
}

function formatCountdownFromExpiry() {
    if (!expiresAtMs) return '--:--';
    const s = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function formatAmount(v, { signed = false } = {}) {
    if (v == null || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    let s;
    if (abs >= 100) s = n.toFixed(2);
    else if (abs >= 1) s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    else s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (!s) s = '0';
    if (signed && n > 0) return `-${s}`;
    if (signed && n < 0) return s;
    if (signed && n === 0) return '0';
    return s;
}

function formatToken(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.floor(n));
}

function loadSavedPos() {
    try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p?.left !== 'number' || typeof p?.top !== 'number') return null;
        return p;
    } catch {
        return null;
    }
}

function savePos(left, top) {
    try {
        localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
    } catch {
        /* ignore */
    }
}

function clampPos(el, left, top) {
    const w = el.offsetWidth || 120;
    const h = el.offsetHeight || 32;
    return {
        left: Math.min(Math.max(0, window.innerWidth - w), Math.max(0, left)),
        top: Math.min(Math.max(0, window.innerHeight - h), Math.max(0, top)),
    };
}

function applyPos(el, left, top) {
    const c = clampPos(el, left, top);
    el.style.left = `${c.left}px`;
    el.style.top = `${c.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return c;
}

function restoreOrDefaultPos(el) {
    const saved = loadSavedPos();
    if (saved) {
        applyPos(el, saved.left, saved.top);
        return;
    }
    el.style.left = 'auto';
    el.style.top = 'auto';
    el.style.right = '';
    el.style.bottom = '';
    requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        applyPos(el, r.left, r.top);
    });
}

function togglePanelFromBar() {
    panelOpen = !panelOpen;
    renderFloat();
}

/**
 * 展开优先：
 * - 按下→松手，期间没真正拖过 → 展开/收起
 * - 按住超过 LONG_PRESS_MS 后才进入可拖状态；再滑出阈值才移动
 * 不靠 click（指针捕获会吞掉 click），松手时自己判定。
 */
function bindFloatDrag(el) {
    if (dragBound || !el) return;
    dragBound = true;
    let pressActive = false;
    let dragArmed = false; // 长按到时，允许拖
    let moved = false;     // 真的拖过了
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let activeId = null;
    let longPressTimer = null;
    let onFist = false;

    const clearLongPress = () => {
        if (longPressTimer != null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    };

    el.addEventListener('pointerdown', (ev) => {
        if (claiming) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        onFist = !!ev.target?.closest?.('.peach-st-fist');
        if (onFist) return;

        const r = el.getBoundingClientRect();
        if (el.style.left === 'auto' || !el.style.left) applyPos(el, r.left, r.top);
        pressActive = true;
        dragArmed = false;
        moved = false;
        suppressClick = false;
        activeId = ev.pointerId;
        startX = ev.clientX;
        startY = ev.clientY;
        origLeft = parseFloat(el.style.left) || r.left;
        origTop = parseFloat(el.style.top) || r.top;
        // 未进拖拽前不抢指针，避免吃掉后续判定
        clearLongPress();
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (!pressActive) return;
            dragArmed = true;
            el.classList.add('peach-st-dragging');
            try { el.setPointerCapture(activeId); } catch { /* ignore */ }
        }, LONG_PRESS_MS);
    });

    el.addEventListener('pointermove', (ev) => {
        if (!pressActive || (activeId != null && ev.pointerId !== activeId)) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const past = Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX;

        if (!dragArmed) {
            // 长按前就滑了：取消武装，松手仍按「单击展开」
            if (past) clearLongPress();
            return;
        }
        if (!past) return;
        moved = true;
        suppressClick = true;
        applyPos(el, origLeft + dx, origTop + dy);
        ev.preventDefault();
    });

    const endPress = (ev) => {
        if (!pressActive || (activeId != null && ev.pointerId !== activeId)) return;
        const didMove = moved;
        clearLongPress();
        pressActive = false;
        dragArmed = false;
        el.classList.remove('peach-st-dragging');
        try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        activeId = null;

        if (didMove) {
            const c = applyPos(el, parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
            savePos(c.left, c.top);
            // 拖过就不再展开
            suppressClick = true;
            return;
        }
        // 没拖过：展开优先（短按或长按未滑）
        if (!onFist) {
            togglePanelFromBar();
        }
    };
    el.addEventListener('pointerup', endPress);
    el.addEventListener('pointercancel', (ev) => {
        if (!pressActive || (activeId != null && ev.pointerId !== activeId)) return;
        clearLongPress();
        pressActive = false;
        dragArmed = false;
        moved = false;
        el.classList.remove('peach-st-dragging');
        try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        activeId = null;
    });
}

function updateKeyBtnState() {
    const $btns = $('.peach-st-key-btn');
    if (!$btns.length) return;
    const has = !!loadApiKeyOverride();
    $btns.toggleClass('peach-st-key-set', has);
    $btns.attr('title', has
        ? '已设优先密钥（点此修改；清空则回退酒馆自定义栏）'
        : '可选：填写后优先用此密钥问缓存；空则用酒馆自定义栏');
}

function promptApiKeyOverride() {
    const cur = loadApiKeyOverride();
    const next = window.prompt(
        '可选优先密钥（只影响问缓存/取回操作）。写了优先用这里；清空并确定则回退酒馆自定义栏。',
        cur,
    );
    if (next === null) return;
    const saved = saveApiKeyOverride(next);
    updateKeyBtnState();
    toast(saved ? '已保存优先密钥' : '已清除优先密钥，改用酒馆自定义栏', 'success');
}

/** 悬浮条展开面底部：分割线 + 🔑（已存在则补上） */
function ensureFloatKeyRow($root) {
    if (!$root?.length) return;
    const $panel = $root.find('.peach-st-panel');
    if (!$panel.length || $panel.find('.peach-st-float-key-row').length) {
        updateKeyBtnState();
        return;
    }
    $panel.append(`
        <hr class="peach-st-float-sep" />
        <div class="peach-st-float-key-row">
            <button type="button" class="peach-st-key-btn peach-st-float-key-btn" aria-label="可选优先密钥">🔑</button>
        </div>
    `);
    $panel.find('.peach-st-float-key-btn').on('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        promptApiKeyOverride();
    });
    updateKeyBtnState();
}

function ensureSettingsDrawer() {
    const $host = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!$host.length) return;

    if (!$('#peach_st_cache_settings').length) {
        const $block = $(`
            <div id="peach_st_cache_settings" class="peach-st-settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>桃子取回</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <p class="peach-st-settings-hint"></p>
                        <div class="menu_button menu_button_icon" id="peach_st_cache_reset_pos">复位悬浮条位置</div>
                        <hr class="peach-st-settings-sep" />
                        <div class="peach-st-settings-key-row">
                            <button type="button" class="peach-st-key-btn" id="peach_st_cache_key_btn" aria-label="可选优先密钥">🔑</button>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $host.append($block);
        $block.find('.inline-drawer-toggle').on('click', function () {
            $(this).closest('.inline-drawer').toggleClass('open');
        });
        $block.find('#peach_st_cache_reset_pos').on('click', () => {
            try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
            saveFloatVisible(true);
            updateWandMenuLabel();
            renderFloat({ forceShow: true });
            const el = document.getElementById(FLOAT_ID);
            if (el) {
                el.style.left = 'auto';
                el.style.top = 'auto';
                el.style.right = '';
                el.style.bottom = '';
                restoreOrDefaultPos(el);
            }
            toast('已复位悬浮条位置', 'success');
        });
        $block.find('#peach_st_cache_key_btn').on('click', (ev) => {
            ev.preventDefault();
            promptApiKeyOverride();
        });
    }

    $('#peach_st_cache_settings .peach-st-settings-hint').text(SETTINGS_HINT);
    if (!$('#peach_st_cache_key_btn').length) {
        const $content = $('#peach_st_cache_settings .inline-drawer-content');
        if ($content.length && !$content.find('.peach-st-settings-sep').length) {
            $content.append(`
                <hr class="peach-st-settings-sep" />
                <div class="peach-st-settings-key-row">
                    <button type="button" class="peach-st-key-btn" id="peach_st_cache_key_btn" aria-label="可选优先密钥">🔑</button>
                </div>
            `);
            $('#peach_st_cache_key_btn').on('click', (ev) => {
                ev.preventDefault();
                promptApiKeyOverride();
            });
        }
    }
    updateKeyBtnState();
}

function updateWandMenuLabel() {
    $(`#${MENU_ID} .peach-st-menu-state`).text(floatVisible ? '显示中' : '已隐藏');
}

function ensureWandMenuButton() {
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    if ($(`#${MENU_ID}`).length) {
        updateWandMenuLabel();
        return;
    }
    const $item = $(`
        <div id="${MENU_ID}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="显示/隐藏桃子取回悬浮条">
            <span class="extensionsMenuExtensionButton peach-st-menu-emoji" aria-hidden="true">🍑</span>
            <span>桃子取回</span>
            <span class="peach-st-menu-state"></span>
        </div>
    `);
    $item.on('click', () => {
        // 魔术棒只显隐；「非桃子站」留给发请求时查本包地址
        saveFloatVisible(!floatVisible);
        updateWandMenuLabel();
        renderFloat({ forceShow: true });
        toast(floatVisible ? '已显示悬浮条' : '已隐藏悬浮条', 'info');
    });
    $menu.append($item);
    updateWandMenuLabel();
}

function hideFloatDom() {
    $(`#${FLOAT_ID}`).remove();
    dragBound = false;
}

function renderFloat({ forceShow = false } = {}) {
    // 显隐只看用户开关；绝不因「像不像桃子站」拆掉药
    let $root = $(`#${FLOAT_ID}`);
    if (!$root.length) {
        $root = $(`
            <div id="${FLOAT_ID}" class="peach-st-idle">
                <div class="peach-st-bar" role="button" tabindex="0">
                    <span class="peach-st-cost">
                        <img class="peach-st-cost-icon" alt="" />
                        <span class="peach-st-cost-num"></span>
                    </span>
                    <span class="peach-st-timer">⏱︎--:--</span>
                    <button type="button" class="peach-st-fist"><img alt="" /></button>
                </div>
                <div class="peach-st-panel">
                    <div class="peach-st-balances">
                        <span><img class="peach-st-bal-icon peach-st-ico-tao" alt="" /><span class="peach-st-bal-peach-num"></span></span>
                        <span><img class="peach-st-bal-icon peach-st-ico-taohe" alt="" /><span class="peach-st-bal-taohe-num"></span></span>
                    </div>
                    <div class="peach-st-rule" aria-hidden="true"></div>
                    <div class="peach-st-tokens">
                        <span>⇡ <span class="peach-st-in"></span></span>
                        <span>⇣ <span class="peach-st-out"></span></span>
                    </div>
                    <div class="peach-st-cache-row">
                        <span>⎘ <span class="peach-st-cache-read"></span></span>
                        <span>✎ <span class="peach-st-cache-create"></span></span>
                    </div>
                    <hr class="peach-st-float-sep" />
                    <div class="peach-st-float-key-row">
                        <button type="button" class="peach-st-key-btn peach-st-float-key-btn" aria-label="可选优先密钥">🔑</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append($root);
        $root.find('.peach-st-cost-icon').attr('src', ICON_TAO);
        $root.find('.peach-st-ico-tao').attr('src', ICON_TAO);
        $root.find('.peach-st-ico-taohe').attr('src', ICON_TAOHE);
        $root.find('.peach-st-fist img').attr('src', ICON_FIST);
        $root.find('.peach-st-float-key-btn').on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            promptApiKeyOverride();
        });

        // 桃子图标：生成中点击 = 与酒馆停止同权（发真中断令）
        $root.find('.peach-st-cost').on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (suppressClick) { suppressClick = false; return; }
            if (genState !== GEN_RUNNING) return;
            try {
                const ctx = getContext();
                if (typeof ctx.stopGeneration === 'function') {
                    ctx.stopGeneration(); // 会触发 GENERATION_STOPPED → sendTrueAbort
                    return;
                }
            } catch { /* ignore */ }
            onUserStopGeneration();
        });
        // 展开改由 pointerup 判定（见 bindFloatDrag），这里只挡误点冒泡
        $root.find('.peach-st-bar').on('click', (ev) => {
            if (ev.target?.closest?.('.peach-st-fist')) return;
            if (ev.target?.closest?.('.peach-st-cost')) return;
            ev.preventDefault();
            ev.stopPropagation();
        });
        $root.find('.peach-st-fist').on('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (suppressClick) { suppressClick = false; return; }
            void onClaimClick();
        });
        restoreOrDefaultPos($root.get(0));
        bindFloatDrag($root.get(0));
    } else if (forceShow) {
        $root.css('display', '');
    }
    // 旧版悬浮条没有🔑时热补上
    ensureFloatKeyRow($root);

    const ready = !!(lastSignal && lastSignal.has_cache && claimToken);
    const costTxt = lastSignal ? formatAmount(lastSignal.actual_cost, { signed: true }) : '';
    const peachBal = lastSignal?.has_peach_balance ? formatAmount(lastSignal.peach_balance) : '';
    const taoheBal = lastSignal?.has_taohe_balance ? formatAmount(lastSignal.taohe_balance) : '';

    $root.toggleClass('peach-st-hidden', !floatVisible);
    $root.toggleClass('peach-st-ready', ready);
    $root.toggleClass('peach-st-waiting', waitingBackend && !ready);
    $root.toggleClass('peach-st-idle', !ready && !waitingBackend);
    $root.toggleClass('peach-st-busy', claiming);
    $root.toggleClass('peach-st-open', panelOpen && floatVisible);
    $root.toggleClass('peach-st-gen-running', genState === GEN_RUNNING);
    $root.find('.peach-st-cost').attr('title', genState === GEN_RUNNING ? '点击＝真中断（告知中转停收）' : '费用');

    $root.find('.peach-st-cost-num').text(costTxt);
    $root.find('.peach-st-timer').text(`⏱︎${ready || (lastSignal && lastSignal.has_cache) ? formatCountdownFromExpiry() : '--:--'}`);
    $root.find('.peach-st-in').text(lastSignal?.has_cache ? formatToken(lastSignal.prompt_tokens) : '');
    $root.find('.peach-st-out').text(lastSignal?.has_cache ? formatToken(lastSignal.completion_tokens) : '');
    $root.find('.peach-st-cache-read').text(lastSignal?.has_cache ? formatToken(lastSignal.cache_read_tokens) : '');
    $root.find('.peach-st-cache-create').text(lastSignal?.has_cache ? formatToken(lastSignal.cache_creation_tokens) : '');
    $root.find('.peach-st-bal-peach-num').text(peachBal);
    $root.find('.peach-st-bal-taohe-num').text(taoheBal);
    $root.find('.peach-st-fist').prop('disabled', !ready || claiming);
}

/**
 * 入泡：送到酒馆「门口」走正规建楼，不自己解析思考。
 *
 * 根因：appendFinal 里是 extra.reasoning +=（往旧思考后面拼），流式留下的半截思考
 * 不会被换掉，思考区铅笔改的也是同一份 extra.reasoning。
 *
 * 正经路：找最后用户楼；下一层若是 AI（半截/旧楼）先删掉腾门口；
 * 再 saveReply({ type:'normal', reasoning })——与非流入泡同一套赋值+渲染。
 * 仅当 AI 不在末尾（中间夹楼）时才原地改字段并 updateReasoningUI。
 */
async function applyClaimedText(text, reasoning) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat)) {
        toast('当前没有打开的聊天', 'warning');
        return false;
    }
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        toast('取回内容为空', 'warning');
        return false;
    }
    // 思考链：中转原样送来，交给酒馆 saveReply / 思考 UI，不在这里拆标签
    const reasoningText = String(reasoning || '').trim();
    if (typeof ctx.saveReply !== 'function') {
        toast('当前酒馆版本不支持正规入泡', 'error');
        return false;
    }
    // 与酒馆 getLastMessageId({ filter: m => m.is_user && !m.is_system }) 同口径
    const flagOn = (v) => v === true || v === 1 || v === 'true' || v === '1';
    const isUserMsg = (m) => !!(m && flagOn(m.is_user) && !flagOn(m.is_system));
    const isCharMsg = (m) => !!(m && !flagOn(m.is_user) && !flagOn(m.is_system));
    let userIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isUserMsg(chat[i])) {
            userIdx = i;
            break;
        }
    }
    const aiIdx = userIdx >= 0 ? userIdx + 1 : -1;
    const aiAtNext = aiIdx >= 0 && aiIdx < chat.length && isCharMsg(chat[aiIdx]);
    const aiIsLast = aiAtNext && aiIdx === chat.length - 1;
    console.log('[peach-st-cache] claim bubble decide', {
        userIdx,
        aiIdx,
        aiAtNext,
        aiIsLast,
        chatLen: chat.length,
        hasReasoning: !!reasoningText,
        branch: aiAtNext
            ? (aiIsLast ? 'deleteThenNormal' : 'patchFloor+reasoningUI')
            : 'normal',
    });
    try {
        if (aiAtNext && aiIsLast) {
            // 半截/旧 AI 在末尾：先拆楼腾门口，再走 normal（赋值 reasoning，不是 +=）
            if (typeof ctx.deleteLastMessage === 'function') {
                await ctx.deleteLastMessage();
            } else if (typeof ctx.deleteMessage === 'function') {
                await ctx.deleteMessage(aiIdx, undefined, false, true);
            } else {
                chat.pop();
            }
            await ctx.saveReply({ type: 'normal', getMessage: trimmed, reasoning: reasoningText });
            toast('已取回并正规写入（含思考）', 'success');
        } else if (aiAtNext) {
            // 中间夹楼：normal 只能建在末尾，只能原地换正文+思考并刷 UI
            chat[aiIdx].mes = trimmed;
            if (!chat[aiIdx].extra || typeof chat[aiIdx].extra !== 'object') {
                chat[aiIdx].extra = {};
            }
            chat[aiIdx].extra.reasoning = reasoningText;
            if (typeof ctx.updateMessageBlock === 'function') {
                ctx.updateMessageBlock(aiIdx, chat[aiIdx]);
            }
            if (typeof ctx.updateReasoningUI === 'function') {
                ctx.updateReasoningUI(aiIdx, { reset: true });
            }
            toast('已覆盖中间 AI 楼层（含思考）', 'success');
        } else {
            // 用户下一层空着：门口正规建楼
            await ctx.saveReply({ type: 'normal', getMessage: trimmed, reasoning: reasoningText });
            toast('已新建 AI 回复（取回）', 'success');
        }
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        return true;
    } catch (e) {
        console.warn('[peach-st-cache] saveReply failed', e);
        toast('入泡失败，请重试', 'error');
        return false;
    }
}

/** 步骤5：凭票取回（不带 API 密钥） */
async function onClaimClick() {
    if (claiming) return;
    if (!claimToken) {
        toast('暂无可取回回复', 'info');
        return;
    }
    const { baseUrl } = getCustomEndpoint();
    if (!baseUrl) return;

    claiming = true;
    renderFloat();
    try {
        const res = await fetch(`${baseUrl}/v1/peach-st/cache/claim-by-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claim_token: claimToken }),
        });
        if (res.status === 204) {
            toast('缓存已过期或不存在', 'warning');
            claimToken = '';
            if (lastSignal) lastSignal.has_cache = false;
            return;
        }
        if (!res.ok) {
            toast(`取回失败 ${res.status}`, 'error');
            return;
        }
        const body = await res.json();
        if (!body?.text) {
            toast('取回内容为空', 'warning');
            return;
        }
        await applyClaimedText(body.text, body.reasoning);
        // 取回不毁：票与倒计时保留至 TTL / 新标记消息
        toast('已取回写入气泡（缓存仍保留至倒计时结束）', 'success');
        panelOpen = false;
    } catch (e) {
        console.warn('[peach-st-cache] claim failed', e);
        toast('取回请求失败', 'error');
    } finally {
        claiming = false;
        renderFloat();
    }
}

function bindHooks() {
    if (hooksBound) return;
    const ctx = getContext();
    const es = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types;
    if (!es || !et) return;
    hooksBound = true;

    if (et.CHAT_COMPLETION_SETTINGS_READY) {
        es.on(et.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    }
    // 真中断：只认用户点停止（GENERATION_STOPPED）。刷新/卸扩展不会发此事件。
    if (et.GENERATION_STOPPED) {
        es.on(et.GENERATION_STOPPED, onUserStopGeneration);
    }
    if (et.GENERATION_ENDED) {
        es.on(et.GENERATION_ENDED, onGenerationEndedNormally);
    }
    // 进角色/换聊天后再补问缓存（不抢 APP 启动）
    if (et.CHAT_CHANGED) {
        es.on(et.CHAT_CHANGED, () => {
            renderFloat({ forceShow: true });
            scheduleCachePoll('chat_changed', 600);
        });
    }
    if (et.APP_READY) {
        es.on(et.APP_READY, () => {
            scheduleCachePoll('app_ready', 1500);
        });
    }

    // 换源/换模：只刷新条，不做站别判断、不拆药
    const recheck = () => {
        renderFloat({ forceShow: true });
        scheduleCachePoll('endpoint_recheck', 900);
    };
    if (et.CHATCOMPLETION_SOURCE_CHANGED) es.on(et.CHATCOMPLETION_SOURCE_CHANGED, recheck);
    if (et.CHATCOMPLETION_MODEL_CHANGED) es.on(et.CHATCOMPLETION_MODEL_CHANGED, recheck);
}

function init() {
    patchFetchForReclaim();
    ensureSettingsDrawer();
    ensureWandMenuButton();
    bindHooks();
    // 启动只画悬浮条；站别判断留给发请求
    renderFloat();

    setTimeout(ensureSettingsDrawer, 1500);
    setTimeout(ensureWandMenuButton, 1500);
    setTimeout(ensureWandMenuButton, 4000);
    setTimeout(bindHooks, 2000);
    // 若扩展晚于 APP_READY 加载：稍后再试一次（仍要求已在角色里）
    setTimeout(() => scheduleCachePoll('late_init', 2500), 2500);

    console.log('[peach-st-cache] ready (push + resume poll)');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
