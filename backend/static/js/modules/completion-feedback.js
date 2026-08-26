// ===========================================================================
// Completion feedback — AMC-aligned (showNotification / playCompletionSound).
//
// Fires when a search stream finishes: an optional desktop notification
// (only while the tab is hidden, so it never pings the user mid-read) and an
// optional short two-tone chime. Settings live in the general tab.
// ===========================================================================

const NOTE_E5_FREQUENCY = 659.25;
const NOTE_C5_FREQUENCY = 523.25;
const FIRST_NOTE_DURATION_S = 0.15;
const SECOND_NOTE_DURATION_S = 0.2;
const NOTIFICATION_AUTO_CLOSE_MS = 7000;

// AudioContext 单例：浏览器对同页面 AudioContext 数量有上限（约 6 个），
// 每次播放都新建会导致之后声音永久失效。惰性创建后跨播放复用，不再 close。
let _audioCtx = null;

/**
 * Strip markdown so a notification body reads as plain text, and cap its
 * length (mirrors AMC buildCompletionNotificationBody).
 */
export function sanitizeCompletionText(text, max = 150) {
    return String(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_~`]+/g, '')
        .replace(/^>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * Show a desktop notification. Returns true when one was actually shown.
 * Never asks for permission here — permission is requested from the settings
 * toggle; if the browser does not support notifications or permission is not
 * granted yet, this is a silent no-op.
 */
export function showCompletionNotification(title, body) {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    try {
        const notification = new Notification(title, {
            body: sanitizeCompletionText(body),
            tag: 'justsearch-completion',
            renotify: true,
        });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        setTimeout(() => notification.close(), NOTIFICATION_AUTO_CLOSE_MS);
        return true;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Failed to create completion notification', err);
        return false;
    }
}

/**
 * Play a short two-tone completion chime (E5 → C5) via WebAudio.
 */
export function playCompletionSound() {
    if (typeof window === 'undefined') return;
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!_audioCtx) _audioCtx = new AudioContextClass();
        const ctx = _audioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const notes = [
            { frequency: NOTE_E5_FREQUENCY, startTime: 0, duration: FIRST_NOTE_DURATION_S },
            { frequency: NOTE_C5_FREQUENCY, startTime: FIRST_NOTE_DURATION_S, duration: SECOND_NOTE_DURATION_S },
        ];
        notes.forEach(({ frequency, startTime, duration }) => {
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + startTime);
            gain.gain.setValueAtTime(0.0001, ctx.currentTime + startTime);
            gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + startTime + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startTime + duration);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start(ctx.currentTime + startTime);
            oscillator.stop(ctx.currentTime + startTime + duration);
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Error playing completion sound', err);
    }
}
