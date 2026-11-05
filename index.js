// @ts-nocheck
/**
 * 桃子取回 — 断线/超时后，从中转侧 120 秒缓存握拳取回已计费回复。
 * 自动往自定义接口附加请求头 X-Peach-ST-Client: 1。
 */
import { getContext } from '../../../st-context.js';
import { SECRET_KEYS, findSecret } from '../../../secrets.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';

const HEADER_NAME = 'X-Peach-ST-Client';
const HEADER_LINE = `${HEADER_NAME}: 1`;
const POLL_IDLE_MS = 8000;
const POLL_ACTIVE_MS = 2000;
const FLOAT_ID = 'peach-st-cache-float';
/** 图标相对本插件文件，不依赖酒馆树里的固定路径 */
const ICON_PEACH = new URL('./icons/peach.svg', import.meta.url).href;
const ICON_FIST = new URL('./icons/fist.svg', import.meta.url).href;

/** @type {{ has_cache?: boolean, remaining_seconds?: number, prompt_tokens?: number, completion_tokens?: number } | null} */
let lastStatus = null;
let pollTimer = null;
let claiming = false;
let headerEnsured = false;

function toast(text, type = 'info') {
    try {
        toastr?.[type]?.(text) ?? console.log(`[peach-st-cache] ${text}`);
    } catch {
        console.log(`[peach-st-cache] ${text}`);
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
    };
}

async function getCustomApiKey() {
    try {
        const value = await findSecret(SECRET_KEYS.CUSTOM);
        return String(value || '').trim();
    } catch (e) {
        console.warn('[peach-st-cache] findSecret failed', e);
        return '';
    }
}

/**
 * 把标记头写进自定义「附加请求头」，不覆盖用户其它头。
 */
function ensureMarkerHeader() {
    const ctx = getContext();
    const settings = ctx.chatCompletionSettings;
    if (!settings) return;

    const raw = String(settings.custom_include_headers || '');
    const lines = raw.split(/\r?\n/);
    const has = lines.some((line) => {
        const t = line.trim().toLowerCase();
        return t.startsWith('x-peach-st-client:');
    });
    if (has) {
        headerEnsured = true;
        return;
    }

    // 只改内存中的设置，不主动落盘：卸载扩展后刷新，不应在用户设置里留痕。
    const next = raw.trim() ? `${raw.replace(/\s+$/, '')}\n${HEADER_LINE}` : HEADER_LINE;
    settings.custom_include_headers = next;
    headerEnsured = true;

    const $el = $('#custom_include_headers');
    if ($el.length) {
        $el.val(next);
    }
}

async function peachFetch(path, { method = 'GET' } = {}) {
    const { baseUrl } = getCustomEndpoint();
    const apiKey = await getCustomApiKey();
    if (!baseUrl || !apiKey) {
        return { ok: false, status: 0, body: null, reason: 'missing_endpoint' };
    }
    const url = `${baseUrl}/v1/peach-st/cache${path || ''}`;
    try {
        const res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        });
        if (res.status === 204) {
            return { ok: true, status: 204, body: null };
        }
        let body = null;
        const text = await res.text();
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = { raw: text };
            }
        }
        return { ok: res.ok, status: res.status, body };
    } catch (e) {
        console.warn('[peach-st-cache] fetch failed', e);
        return { ok: false, status: 0, body: null, reason: 'network' };
    }
}

function formatCountdown(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

function renderFloat() {
    let $btn = $(`#${FLOAT_ID}`);
    if (!$btn.length) {
        $btn = $(`
            <button type="button" id="${FLOAT_ID}" class="peach-st-idle" title="桃子取回：有可取回复时握拳取回">
                <img class="peach-st-icon" alt="" />
                <span class="peach-st-meta"></span>
                <span class="peach-st-tokens"></span>
            </button>
        `);
        $('body').append($btn);
        $btn.on('click', onFloatClick);
    }

    const ready = !!(lastStatus && lastStatus.has_cache);
    const $icon = $btn.find('.peach-st-icon');
    const $meta = $btn.find('.peach-st-meta');
    const $tok = $btn.find('.peach-st-tokens');

    $btn.toggleClass('peach-st-ready', ready);
    $btn.toggleClass('peach-st-idle', !ready);
    $btn.toggleClass('peach-st-busy', claiming);

    if (ready) {
        $icon.attr('src', ICON_FIST);
        $meta.text(formatCountdown(lastStatus.remaining_seconds));
        const pt = Number(lastStatus.prompt_tokens) || 0;
        const ct = Number(lastStatus.completion_tokens) || 0;
        $tok.text(`${pt}+${ct}`);
        $btn.attr('title', '握拳取回：覆盖最后一条空/失败的 AI 回复，或新建一条');
    } else {
        $icon.attr('src', ICON_PEACH);
        $meta.text('');
        $tok.text('');
        $btn.attr('title', '桃子取回：发送后若断线，计费成功的回复会在此显示约 2 分钟');
    }
}

/**
 * 覆盖最后一条 AI 气泡，或新建。
 * 规则：末条是 AI 且内容空/明显失败占位 → 覆盖；否则新建。
 */
async function applyClaimedText(text) {
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

    const lastIdx = chat.length - 1;
    const last = lastIdx >= 0 ? chat[lastIdx] : null;
    const looksEmptyAi = last
        && last.is_user !== true
        && last.is_system !== true
        && (!String(last.mes || '').trim()
            || /^(null|undefined|error|错误|失败|timeout|timed out)$/i.test(String(last.mes || '').trim()));

    if (looksEmptyAi) {
        last.mes = trimmed;
        if (Array.isArray(last.swipes) && typeof last.swipe_id === 'number') {
            last.swipes[last.swipe_id] = trimmed;
        }
        ctx.updateMessageBlock(lastIdx, last);
        await ctx.saveChat();
        toast('已覆盖最后一条 AI 回复', 'success');
        return true;
    }

    const name = ctx.name2 || 'Assistant';
    const message = {
        name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: trimmed,
        extra: { peach_st_reclaimed: true },
    };
    chat.push(message);
    ctx.addOneMessage(message);
    await ctx.saveChat();
    toast('已新建 AI 回复（取回）', 'success');
    return true;
}

async function onFloatClick() {
    if (claiming) return;
    if (!(lastStatus && lastStatus.has_cache)) {
        toast('暂无可取回回复', 'info');
        return;
    }
    claiming = true;
    renderFloat();
    try {
        const res = await peachFetch('/claim', { method: 'POST' });
        if (res.status === 204 || !res.body?.text) {
            lastStatus = null;
            toast('缓存已过期或不存在', 'warning');
            return;
        }
        await applyClaimedText(res.body.text);
        lastStatus = null;
    } finally {
        claiming = false;
        renderFloat();
        schedulePoll(true);
    }
}

async function pollOnce() {
    ensureMarkerHeader();
    const { source, baseUrl } = getCustomEndpoint();
    if (source !== 'custom' || !baseUrl) {
        lastStatus = null;
        renderFloat();
        return;
    }

    const res = await peachFetch('');
    if (res.status === 204 || !res.ok) {
        lastStatus = null;
    } else if (res.body && res.body.has_cache) {
        lastStatus = res.body;
    } else {
        lastStatus = null;
    }
    renderFloat();
}

function schedulePoll(immediate = false) {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    const delay = immediate
        ? 0
        : (lastStatus?.has_cache ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    pollTimer = setTimeout(async () => {
        try {
            await pollOnce();
        } catch (e) {
            console.warn('[peach-st-cache] poll error', e);
        }
        schedulePoll(false);
    }, delay);
}

function bindGenerationHooks() {
    const ctx = getContext();
    const es = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types;
    if (!es || !et) return;

    const bump = () => {
        // 新请求发出后服务端会销毁旧缓存；稍后再轮询。
        lastStatus = null;
        renderFloat();
        schedulePoll(true);
        setTimeout(() => schedulePoll(true), 2500);
    };

    if (et.GENERATION_STARTED) es.on(et.GENERATION_STARTED, bump);
    if (et.GENERATION_ENDED) es.on(et.GENERATION_ENDED, () => setTimeout(() => schedulePoll(true), 1200));
    if (et.GENERATION_STOPPED) es.on(et.GENERATION_STOPPED, () => setTimeout(() => schedulePoll(true), 800));
}

function init() {
    ensureMarkerHeader();
    renderFloat();
    bindGenerationHooks();
    schedulePoll(true);

    // 设置面板可能晚一点才挂载输入框，再补一次头。
    setTimeout(ensureMarkerHeader, 2000);
    setTimeout(ensureMarkerHeader, 8000);

    console.log('[peach-st-cache] ready');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
