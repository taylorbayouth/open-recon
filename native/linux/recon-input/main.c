// recon-input — Linux X11 OS-level mouse/keyboard driver for Open Recon.
//
// Mirrors the macOS Swift helper exactly: newline-delimited JSON on stdin,
// newline-delimited JSON responses on stdout. Same op protocol, same
// response shape — os.js needs no structural changes.
//
// Requires: X11 display with XTEST and XScreenSaver extensions.
// Link:     cc main.c -O2 -o recon-input $(pkg-config --cflags --libs x11 xtst xscrnsaver)
//
// The one non-trivial op is `type`: X11 has no "inject literal character"
// primitive, so we temporarily remap a spare keycode to the target codepoint's
// keysym (XK_Unicode prefix 0x01000000), send key down/up, then restore. This
// types any Unicode regardless of the current keyboard layout.
//
// Ops implemented (same contract as macos/recon-input/main.swift):
//   ping, pos, axtrusted, frontapp, raise
//   move, click, down, up
//   type, key, scroll, scrollGesture
//   idle

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/scrnsaver.h>

// ─── Minimal JSON parser ──────────────────────────────────────────────────────
// We only need: get string by key, get number by key, get string-array by key.
// Full-blown deps are out of scope for a tiny native helper; this is enough.

// Returns a pointer into `json` at the first char of the value for `key`,
// or NULL if not found. Handles one level of nesting only (flat object).
static const char *json_find(const char *json, const char *key) {
    char needle[256];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return NULL;
    p += strlen(needle);
    while (*p && (*p == ' ' || *p == ':' || *p == '\t')) p++;
    return *p ? p : NULL;
}

// Extract a string value into `out` (max `outlen`). Returns 1 on success.
static int json_str(const char *json, const char *key, char *out, size_t outlen) {
    const char *v = json_find(json, key);
    if (!v || *v != '"') return 0;
    v++;
    size_t i = 0;
    while (*v && *v != '"' && i + 1 < outlen) {
        if (*v == '\\') {
            v++;
            switch (*v) {
                case 'n': out[i++] = '\n'; break;
                case 't': out[i++] = '\t'; break;
                case '"': out[i++] = '"';  break;
                case '\\': out[i++] = '\\'; break;
                default:  out[i++] = *v;  break;
            }
        } else {
            out[i++] = *v;
        }
        v++;
    }
    out[i] = '\0';
    return 1;
}

// Extract a double. Returns 1 on success.
static int json_num(const char *json, const char *key, double *out) {
    const char *v = json_find(json, key);
    if (!v) return 0;
    char *end;
    double d = strtod(v, &end);
    if (end == v) return 0;
    *out = d;
    return 1;
}

// Extract an int. Returns 1 on success.
static int json_int(const char *json, const char *key, int *out) {
    double d;
    if (!json_num(json, key, &d)) return 0;
    *out = (int)d;
    return 1;
}

// Collect string values from a JSON array for `key` into `arr` (max `max`).
// Returns count found.
static int json_strarray(const char *json, const char *key, char arr[][64], int max) {
    const char *v = json_find(json, key);
    if (!v || *v != '[') return 0;
    v++;
    int n = 0;
    while (*v && *v != ']' && n < max) {
        while (*v && (*v == ' ' || *v == ',')) v++;
        if (*v == '"') {
            v++;
            int i = 0;
            while (*v && *v != '"' && i < 63) arr[n][i++] = *v++;
            arr[n][i] = '\0';
            if (*v == '"') v++;
            n++;
        } else if (*v == ']') {
            break;
        } else {
            v++;
        }
    }
    return n;
}

// ─── JSON output ─────────────────────────────────────────────────────────────

static void write_ok(const char *id, const char *body) {
    // body is pre-formatted key:value pairs (without outer braces), may be "".
    if (body && *body)
        printf("{\"id\":\"%s\",\"ok\":true,\"data\":{%s}}\n", id, body);
    else
        printf("{\"id\":\"%s\",\"ok\":true,\"data\":{}}\n", id);
    fflush(stdout);
}

static void write_fail(const char *id, const char *msg) {
    // Escape double quotes in msg to keep JSON valid.
    printf("{\"id\":\"%s\",\"ok\":false,\"error\":\"", id);
    for (const char *p = msg; *p; p++) {
        if (*p == '"') fputs("\\\"", stdout);
        else if (*p == '\\') fputs("\\\\", stdout);
        else fputc(*p, stdout);
    }
    printf("\"}\n");
    fflush(stdout);
}

// ─── Timing helpers ───────────────────────────────────────────────────────────

static void sleep_ms(int ms) {
    if (ms <= 0) return;
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

// Monotonic clock in seconds (same role as Swift's monoNowSecs).
static double mono_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

// Random double in [lo, hi).
static double randf(double lo, double hi) {
    return lo + (hi - lo) * ((double)rand() / ((double)RAND_MAX + 1.0));
}

// ─── Global state ─────────────────────────────────────────────────────────────

static Display *dpy = NULL;
static int      screen_num = 0;
static Window   root = None;

// Mirrors Swift's leftButtonDown: while held, XTEST auto-sends MotionNotify
// as a drag (no distinction needed at the X11 level — we track it only to
// replicate the helper's gate logic for clarity).
static int left_button_down = 0;

// Timestamp of last event WE injected (for idle self-subtraction, same as
// Swift's lastSelfInputMono / markSelfInput).
static double last_self_input = 0.0;
static void mark_self_input(void) { last_self_input = mono_now(); }

// ─── Mouse ────────────────────────────────────────────────────────────────────

static void get_cursor_pos(int *x, int *y) {
    Window child;
    int rx, ry, wx, wy;
    unsigned int mask;
    XQueryPointer(dpy, root, &root, &child, &rx, &ry, &wx, &wy, &mask);
    *x = rx; *y = ry;
}

// Bézier ease-in-out — exact same formula as main.swift:180.
static double ease_inout(double t) {
    return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
}

// Humanlike mouse motion — mirrors humanMove() in main.swift verbatim.
// X11 simplification: there is no leftMouseDragged vs mouseMoved distinction;
// XTEST moves with the button held are automatically treated as drags by
// receiving apps. The leftButtonDown branch in the Swift version disappears.
static void human_move(double tx, double ty, double speed_px_sec, double jitter_px) {
    int sx, sy;
    get_cursor_pos(&sx, &sy);

    double dx = tx - sx, dy = ty - sy;
    double dist = sqrt(dx*dx + dy*dy);

    if (dist < 0.5) {
        XTestFakeMotionEvent(dpy, screen_num, (int)tx, (int)ty, CurrentTime);
        XFlush(dpy);
        return;
    }

    double speed = speed_px_sec < 50 ? 50 : speed_px_sec;
    double dur_ms = (dist / speed) * 1000.0;
    int frame_ms = 16;
    int steps = (int)ceil(dur_ms / frame_ms);
    if (steps < 2) steps = 2;

    double nx = -dy / dist, ny = dx / dist;
    double sway = dist * 0.10 * randf(-1, 1);
    double c1x = sx + dx * 0.33 + nx * sway,    c1y = sy + dy * 0.33 + ny * sway;
    double c2x = sx + dx * 0.66 + nx * sway * 0.5, c2y = sy + dy * 0.66 + ny * sway * 0.5;

    for (int i = 1; i <= steps; i++) {
        double t  = (double)i / steps;
        double te = ease_inout(t);
        double u  = 1 - te;
        double bx = u*u*u*sx + 3*u*u*te*c1x + 3*u*te*te*c2x + te*te*te*tx;
        double by = u*u*u*sy + 3*u*u*te*c1y + 3*u*te*te*c2y + te*te*te*ty;
        double jx = jitter_px > 0 ? randf(-jitter_px, jitter_px) : 0;
        double jy = jitter_px > 0 ? randf(-jitter_px, jitter_px) : 0;
        XTestFakeMotionEvent(dpy, screen_num, (int)(bx+jx), (int)(by+jy), CurrentTime);
        XFlush(dpy);
        sleep_ms(frame_ms);
    }
    // Land exactly on target.
    XTestFakeMotionEvent(dpy, screen_num, (int)tx, (int)ty, CurrentTime);
    XFlush(dpy);
}

// X11 button numbers: 1=left, 2=middle, 3=right, 4=wheel-up, 5=wheel-down.
static int button_num(const char *name) {
    if (strcmp(name, "right") == 0)          return 3;
    if (strcmp(name, "center") == 0 ||
        strcmp(name, "middle") == 0)          return 2;
    return 1;
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

// Named keys → X11 keysyms. Mirrors main.swift NAMED_KEYS.
static KeySym named_keysym(const char *name) {
    // Navigation / control
    if (!strcmp(name,"return")||!strcmp(name,"enter")) return XK_Return;
    if (!strcmp(name,"tab"))       return XK_Tab;
    if (!strcmp(name,"space"))     return XK_space;
    if (!strcmp(name,"delete")||!strcmp(name,"backspace")) return XK_BackSpace;
    if (!strcmp(name,"escape")||!strcmp(name,"esc"))       return XK_Escape;
    if (!strcmp(name,"left"))      return XK_Left;
    if (!strcmp(name,"right"))     return XK_Right;
    if (!strcmp(name,"down"))      return XK_Down;
    if (!strcmp(name,"up"))        return XK_Up;
    if (!strcmp(name,"home"))      return XK_Home;
    if (!strcmp(name,"end"))       return XK_End;
    if (!strcmp(name,"pageup"))    return XK_Page_Up;
    if (!strcmp(name,"pagedown"))  return XK_Page_Down;
    // F-keys
    if (!strcmp(name,"f1"))  return XK_F1;  if (!strcmp(name,"f2"))  return XK_F2;
    if (!strcmp(name,"f3"))  return XK_F3;  if (!strcmp(name,"f4"))  return XK_F4;
    if (!strcmp(name,"f5"))  return XK_F5;  if (!strcmp(name,"f6"))  return XK_F6;
    if (!strcmp(name,"f7"))  return XK_F7;  if (!strcmp(name,"f8"))  return XK_F8;
    if (!strcmp(name,"f9"))  return XK_F9;  if (!strcmp(name,"f10")) return XK_F10;
    if (!strcmp(name,"f11")) return XK_F11; if (!strcmp(name,"f12")) return XK_F12;
    // Letters — lowercase names only (executor sends lowercase).
    if (strlen(name) == 1 && name[0] >= 'a' && name[0] <= 'z')
        return XK_a + (name[0] - 'a');
    // Digits
    if (strlen(name) == 1 && name[0] >= '0' && name[0] <= '9')
        return XK_0 + (name[0] - '0');
    return NoSymbol;
}

// Modifier name → keycode. We press the modifier key itself around the target.
static KeyCode modifier_keycode(const char *name) {
    KeySym ks = NoSymbol;
    if (!strcmp(name,"ctrl")||!strcmp(name,"control"))  ks = XK_Control_L;
    else if (!strcmp(name,"shift"))                      ks = XK_Shift_L;
    else if (!strcmp(name,"alt")||!strcmp(name,"option"))ks = XK_Alt_L;
    // "cmd"/"meta"/"command" on Linux → Super (closest equivalent for accelerators)
    else if (!strcmp(name,"cmd")||!strcmp(name,"command")||!strcmp(name,"meta"))
                                                         ks = XK_Super_L;
    if (ks == NoSymbol) return 0;
    return XKeysymToKeycode(dpy, ks);
}

// Find a spare keycode — one that has no keysym bound — to temporarily
// remap for Unicode character injection. Scans from 9 downward (low keycodes
// are rarely used on modern X11 servers; keycodes 8..255 are valid).
// Returns 0 if none found (extremely unlikely on any real server).
static KeyCode find_spare_keycode(void) {
    int min_kc, max_kc;
    XDisplayKeycodes(dpy, &min_kc, &max_kc);
    int ks_per_kc;
    KeySym *map = XGetKeyboardMapping(dpy, min_kc, max_kc - min_kc + 1, &ks_per_kc);
    KeyCode spare = 0;
    for (int kc = max_kc; kc >= min_kc && !spare; kc--) {
        int all_nosymbol = 1;
        for (int i = 0; i < ks_per_kc; i++) {
            if (map[(kc - min_kc) * ks_per_kc + i] != NoSymbol) {
                all_nosymbol = 0;
                break;
            }
        }
        if (all_nosymbol) spare = (KeyCode)kc;
    }
    XFree(map);
    return spare;
}

// Type a single Unicode codepoint by temporarily mapping it onto a spare
// keycode. Serialized: we hold the X server's keyboard mapping, inject
// press+release, then restore — no real keystroke can interleave because the
// remap is live for only the two XTEST events.
static void type_codepoint(unsigned int cp, KeyCode spare) {
    if (!spare) return;

    // X11 Unicode keysym: 0x01000000 | codepoint (for cp > 0x20).
    // For standard ASCII control chars, fall back to their direct keysyms.
    KeySym ks;
    if (cp < 0x20) {
        // Control characters: use the XK_ constant directly.
        ks = cp;
    } else {
        ks = 0x01000000U | cp;
    }

    // Remap the spare keycode to our keysym.
    XChangeKeyboardMapping(dpy, spare, 1, &ks, 1);
    XFlush(dpy);
    // Brief sync: let the X server process the remap before we fire the key.
    // 5ms is sufficient; less risks the server still having the old mapping.
    sleep_ms(5);

    XTestFakeKeyEvent(dpy, spare, True,  CurrentTime);
    XTestFakeKeyEvent(dpy, spare, False, CurrentTime);
    XFlush(dpy);
    sleep_ms(5);  // let key events land before we restore

    // Restore the spare keycode to NoSymbol.
    KeySym no = NoSymbol;
    XChangeKeyboardMapping(dpy, spare, 1, &no, 1);
    XFlush(dpy);
}

// Type a UTF-8 string with per-character humanized delay.
// Decodes UTF-8 to codepoints; each character goes through type_codepoint.
static void type_text(const char *text, int delay_lo, int delay_hi) {
    KeyCode spare = find_spare_keycode();
    const unsigned char *p = (const unsigned char *)text;

    while (*p) {
        unsigned int cp;
        if      (*p < 0x80) { cp = *p++; }
        else if (*p < 0xE0) { cp = (*p++ & 0x1F) << 6;  cp |= (*p++ & 0x3F); }
        else if (*p < 0xF0) { cp = (*p++ & 0x0F) << 12; cp |= (*p++ & 0x3F) << 6;  cp |= (*p++ & 0x3F); }
        else                { cp = (*p++ & 0x07) << 18; cp |= (*p++ & 0x3F) << 12; cp |= (*p++ & 0x3F) << 6; cp |= (*p++ & 0x3F); }

        type_codepoint(cp, spare);

        int lo = delay_lo < 0 ? 0 : delay_lo;
        int hi = delay_hi < lo ? lo : delay_hi;
        int d = (lo == hi) ? lo : lo + rand() % (hi - lo + 1);
        if (d > 0) sleep_ms(d);
    }
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
//
// XTEST has no pixel-wheel primitive; X11 uses discrete button events.
// Button 4 = wheel up (content moves up = scroll down gesture → negative dy in
// os.js convention), button 5 = wheel down, 6 = left, 7 = right.
//
// os.js scroll sign (osScrollDeltas): dy < 0 means "scroll content down"
// (same as DOM wheel deltaY > 0). On X11, button 5 scrolls content down.
// So: dy > 0 → button 4 (content up), dy < 0 → button 5 (content down).
// Similarly dx < 0 → button 6, dx > 0 → button 7.
//
// One XTEST button click ≈ 1 "notch" ≈ ~120 DOM wheel units ≈ ~40px scroll.
// We quantize the requested pixel amount to notches (1 notch per 40px).

static void post_button_click(int btn) {
    XTestFakeButtonEvent(dpy, btn, True,  CurrentTime);
    XTestFakeButtonEvent(dpy, btn, False, CurrentTime);
    XFlush(dpy);
}

static void post_scroll(int dx, int dy) {
    // dy: positive = content up (btn 4), negative = content down (btn 5).
    int ny = (int)round(abs(dy) / 40.0);
    int nx = (int)round(abs(dx) / 40.0);
    int btn_y = (dy >= 0) ? 4 : 5;
    int btn_x = (dx >= 0) ? 7 : 6;
    for (int i = 0; i < ny; i++) post_button_click(btn_y);
    for (int i = 0; i < nx; i++) post_button_click(btn_x);
}

// Humanlike scroll: spread notches across durationMs with ease-in-out timing
// and per-notch jitter. Mirrors postScrollGesture() in main.swift.
// Note: X11 has no scroll-phase (Began/Changed/Ended) equivalent — Chrome
// doesn't need it here because XTEST scroll events go to whatever window is
// under the cursor, not requiring a phase latch like macOS trackpad events do.
static void post_scroll_gesture(int dx, int dy, double dur_ms, double jitter_px) {
    int ny = (int)round(abs(dy) / 40.0);
    int nx = (int)round(abs(dx) / 40.0);
    int total = ny + nx;
    if (total == 0) return;

    int btn_y = (dy >= 0) ? 4 : 5;
    int btn_x = (dx >= 0) ? 7 : 6;
    int frame_ms = 16;
    int steps = (int)ceil(dur_ms / frame_ms);
    if (steps < 3) steps = 3;

    // Distribute notch firings using ease-in-out: fire a notch whenever the
    // cumulative eased fraction crosses the next notch threshold.
    double prev = 0;
    int fired_y = 0, fired_x = 0;
    for (int i = 1; i <= steps; i++) {
        double cur = ease_inout((double)i / steps);
        int target_y = (int)round(cur * ny);
        int target_x = (int)round(cur * nx);
        while (fired_y < target_y) { post_button_click(btn_y); fired_y++; }
        while (fired_x < target_x) { post_button_click(btn_x); fired_x++; }
        (void)prev; prev = cur;
        // Jitter: small random sleep per frame.
        int base = frame_ms;
        int jitter = jitter_px > 0 ? (int)(randf(0, jitter_px)) : 0;
        sleep_ms(base + jitter);
    }
    // Flush any remainder.
    while (fired_y < ny) { post_button_click(btn_y); fired_y++; }
    while (fired_x < nx) { post_button_click(btn_x); fired_x++; }
}

// ─── Window management ────────────────────────────────────────────────────────

// Read a cardinal property from a window, first long only.
static unsigned long get_cardinal(Window w, Atom a) {
    Atom type; int fmt; unsigned long n, after;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, w, a, 0, 1, False, XA_CARDINAL,
                           &type, &fmt, &n, &after, &data) == Success && data) {
        unsigned long v = *(unsigned long *)data;
        XFree(data);
        return v;
    }
    return 0;
}

// Get the active window via _NET_ACTIVE_WINDOW on the root.
static Window get_active_window(void) {
    Atom net_active = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    Atom type; int fmt; unsigned long n, after;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, root, net_active, 0, 1, False, XA_WINDOW,
                           &type, &fmt, &n, &after, &data) == Success && data) {
        Window w = *(Window *)data;
        XFree(data);
        return w;
    }
    return None;
}

// Get WM_CLASS (instance and class name) for a window.
// Returns 1 on success; fills `cls` with the class part (e.g. "Google-chrome").
static int get_wm_class(Window w, char *cls, size_t cls_len,
                         char *inst, size_t inst_len) {
    XClassHint hint;
    if (!XGetClassHint(dpy, w, &hint)) return 0;
    if (inst) snprintf(inst, inst_len, "%s", hint.res_name  ? hint.res_name  : "");
    if (cls)  snprintf(cls,  cls_len,  "%s", hint.res_class ? hint.res_class : "");
    if (hint.res_name)  XFree(hint.res_name);
    if (hint.res_class) XFree(hint.res_class);
    return 1;
}

// Get _NET_WM_PID for a window.
static int get_wm_pid(Window w) {
    Atom net_pid = XInternAtom(dpy, "_NET_WM_PID", False);
    return (int)get_cardinal(w, net_pid);
}

// Get _NET_WM_NAME (UTF-8 window title) for a window. Returns 1 on success.
static int get_wm_name(Window w, char *out, size_t outlen) {
    Atom net_name = XInternAtom(dpy, "_NET_WM_NAME", False);
    Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
    Atom type; int fmt; unsigned long n, after;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, w, net_name, 0, 256, False, utf8,
                           &type, &fmt, &n, &after, &data) == Success && data) {
        snprintf(out, outlen, "%s", (char *)data);
        XFree(data);
        return 1;
    }
    // Fallback to WM_NAME.
    char *name = NULL;
    if (XFetchName(dpy, w, &name) && name) {
        snprintf(out, outlen, "%s", name);
        XFree(name);
        return 1;
    }
    out[0] = '\0';
    return 0;
}

// Raise + focus a window by PID: walk _NET_CLIENT_LIST, match _NET_WM_PID,
// send a _NET_ACTIVE_WINDOW ClientMessage to the root (EWMH spec).
static int raise_by_pid(int target_pid) {
    Atom client_list = XInternAtom(dpy, "_NET_CLIENT_LIST", False);
    Atom type; int fmt; unsigned long n, after;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, root, client_list, 0, 1024, False, XA_WINDOW,
                           &type, &fmt, &n, &after, &data) != Success || !data)
        return 0;
    Window *wins = (Window *)data;
    Window found = None;
    for (unsigned long i = 0; i < n && found == None; i++) {
        if (get_wm_pid(wins[i]) == target_pid) found = wins[i];
    }
    XFree(data);
    if (found == None) return 0;

    // Send _NET_ACTIVE_WINDOW ClientMessage (EWMH). WMs like Mutter/KWin/
    // Openbox all honor this without any special permission.
    Atom net_active = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    XEvent ev = { 0 };
    ev.xclient.type         = ClientMessage;
    ev.xclient.window       = found;
    ev.xclient.message_type = net_active;
    ev.xclient.format       = 32;
    ev.xclient.data.l[0]    = 2;  // source: pager/tool (not application)
    ev.xclient.data.l[1]    = CurrentTime;
    ev.xclient.data.l[2]    = 0;
    XSendEvent(dpy, root, False,
               SubstructureNotifyMask | SubstructureRedirectMask, &ev);
    XFlush(dpy);
    return 1;
}

// ─── Idle detection ───────────────────────────────────────────────────────────
//
// XScreenSaverQueryInfo gives ms since any device event. Like CGEvent's
// secondsSinceLastEventType, XTEST events also reset this counter — so we use
// the same self-subtraction trick as main.swift:447-451:
//
//   userActive = (sysIdle + 50ms) < selfIdle
//
// i.e. the most recent system event is newer than our most recent injection →
// a real human moved/typed after we last acted.

static long get_sys_idle_ms(void) {
    XScreenSaverInfo *info = XScreenSaverAllocInfo();
    if (!info) return 86400000L;
    int ok = XScreenSaverQueryInfo(dpy, root, info);
    long idle = ok ? (long)info->idle : 86400000L;
    XFree(info);
    return idle;
}

// ─── Op dispatch ─────────────────────────────────────────────────────────────

static void handle(const char *line) {
    char id[128]  = "";
    char op[64]   = "";
    json_str(line, "id", id, sizeof(id));
    if (!json_str(line, "op", op, sizeof(op))) {
        write_fail(id, "missing op");
        return;
    }

    // ── ping ──────────────────────────────────────────────────────────────────
    if (!strcmp(op, "ping")) {
        write_ok(id, "\"pong\":true");
        return;
    }

    // ── axtrusted ─────────────────────────────────────────────────────────────
    // On Linux: "trusted" = we have an X display and XTEST is available, and
    // we're not running under Wayland-native (where XTEST would be a no-op).
    if (!strcmp(op, "axtrusted")) {
        const char *wayland = getenv("WAYLAND_DISPLAY");
        const char *session = getenv("XDG_SESSION_TYPE");
        int is_wayland_native = (wayland && *wayland) &&
                                (session && !strcmp(session, "wayland"));
        write_ok(id, is_wayland_native ? "\"trusted\":false" : "\"trusted\":true");
        return;
    }

    // ── pos ───────────────────────────────────────────────────────────────────
    if (!strcmp(op, "pos")) {
        int x, y;
        get_cursor_pos(&x, &y);
        char buf[64];
        snprintf(buf, sizeof(buf), "\"x\":%d,\"y\":%d", x, y);
        write_ok(id, buf);
        return;
    }

    // ── frontapp ──────────────────────────────────────────────────────────────
    // Returns {wmClass, pid, name} — os.js checks wmClass for Chrome bundle IDs;
    // we return the EWMH class string instead (os.js Linux branch checks this).
    if (!strcmp(op, "frontapp")) {
        Window aw = get_active_window();
        char cls[256] = "", inst[256] = "", title[512] = "";
        int pid = 0;
        if (aw != None) {
            get_wm_class(aw, cls, sizeof(cls), inst, sizeof(inst));
            get_wm_name(aw, title, sizeof(title));
            pid = get_wm_pid(aw);
        }
        char buf[1024];
        snprintf(buf, sizeof(buf),
                 "\"wmClass\":\"%s\",\"wmInstance\":\"%s\",\"pid\":%d,\"name\":\"%s\"",
                 cls, inst, pid, title);
        write_ok(id, buf);
        return;
    }

    // ── raise ─────────────────────────────────────────────────────────────────
    if (!strcmp(op, "raise")) {
        int pid = 0;
        if (!json_int(line, "pid", &pid)) { write_fail(id, "raise requires pid"); return; }
        int raised = raise_by_pid(pid);
        write_ok(id, raised ? "\"raised\":true" : "\"raised\":false");
        return;
    }

    // ── move ──────────────────────────────────────────────────────────────────
    if (!strcmp(op, "move")) {
        double x, y;
        if (!json_num(line, "x", &x) || !json_num(line, "y", &y) ||
            !isfinite(x) || !isfinite(y)) {
            write_fail(id, "move requires finite x and y"); return;
        }
        double speed  = 1400, jitter = 0;
        json_num(line, "speedPxPerSec", &speed);
        json_num(line, "jitterPx", &jitter);
        if (!isfinite(speed))  speed  = 1400;
        if (!isfinite(jitter)) jitter = 0;
        human_move(x, y, speed, jitter);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── click ─────────────────────────────────────────────────────────────────
    if (!strcmp(op, "click")) {
        char bname[16] = "left";
        json_str(line, "button", bname, sizeof(bname));
        int btn = button_num(bname);
        XTestFakeButtonEvent(dpy, btn, True,  CurrentTime);
        XTestFakeButtonEvent(dpy, btn, False, CurrentTime);
        XFlush(dpy);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── down ──────────────────────────────────────────────────────────────────
    if (!strcmp(op, "down")) {
        char bname[16] = "left";
        json_str(line, "button", bname, sizeof(bname));
        int btn = button_num(bname);
        if (btn == 1) left_button_down = 1;
        XTestFakeButtonEvent(dpy, btn, True, CurrentTime);
        XFlush(dpy);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── up ────────────────────────────────────────────────────────────────────
    if (!strcmp(op, "up")) {
        char bname[16] = "left";
        json_str(line, "button", bname, sizeof(bname));
        int btn = button_num(bname);
        XTestFakeButtonEvent(dpy, btn, False, CurrentTime);
        if (btn == 1) left_button_down = 0;
        XFlush(dpy);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── type ──────────────────────────────────────────────────────────────────
    if (!strcmp(op, "type")) {
        char text[4096] = "";
        if (!json_str(line, "text", text, sizeof(text))) {
            write_fail(id, "type requires text"); return;
        }
        double lo = 25, hi = 85;
        json_num(line, "delayMsMin", &lo);
        json_num(line, "delayMsMax", &hi);
        type_text(text, (int)lo, (int)hi);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── key ───────────────────────────────────────────────────────────────────
    if (!strcmp(op, "key")) {
        char key[64] = "";
        if (!json_str(line, "key", key, sizeof(key))) {
            write_fail(id, "key requires key name"); return;
        }
        // Lowercase the key name.
        for (char *p = key; *p; p++) *p = (char)tolower((unsigned char)*p);

        KeySym ks = named_keysym(key);
        if (ks == NoSymbol) {
            char errbuf[128];
            snprintf(errbuf, sizeof(errbuf), "unknown key: %s", key);
            write_fail(id, errbuf); return;
        }
        KeyCode kc = XKeysymToKeycode(dpy, ks);
        if (!kc) { write_fail(id, "no keycode for keysym"); return; }

        char mods[8][64];
        int nmod = json_strarray(line, "modifiers", mods, 8);

        // Press modifier keys.
        KeyCode mod_kcs[8] = {0};
        for (int i = 0; i < nmod; i++) {
            char ml[64]; snprintf(ml, sizeof(ml), "%s", mods[i]);
            for (char *p = ml; *p; p++) *p = (char)tolower((unsigned char)*p);
            mod_kcs[i] = modifier_keycode(ml);
            if (mod_kcs[i]) XTestFakeKeyEvent(dpy, mod_kcs[i], True, CurrentTime);
        }

        XTestFakeKeyEvent(dpy, kc, True,  CurrentTime);
        XTestFakeKeyEvent(dpy, kc, False, CurrentTime);

        // Release modifier keys in reverse order.
        for (int i = nmod - 1; i >= 0; i--)
            if (mod_kcs[i]) XTestFakeKeyEvent(dpy, mod_kcs[i], False, CurrentTime);

        XFlush(dpy);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── scroll ────────────────────────────────────────────────────────────────
    if (!strcmp(op, "scroll")) {
        double dx = 0, dy = 0;
        json_num(line, "dx", &dx);
        json_num(line, "dy", &dy);
        post_scroll((int)dx, (int)dy);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── scrollGesture ─────────────────────────────────────────────────────────
    if (!strcmp(op, "scrollGesture")) {
        double dx = 0, dy = 0, dur_ms = 400, jitter = 3;
        json_num(line, "dx", &dx);
        json_num(line, "dy", &dy);
        json_num(line, "durationMs", &dur_ms);
        json_num(line, "jitterPx", &jitter);
        if (!isfinite(dur_ms)) dur_ms = 400;
        if (!isfinite(jitter)) jitter = 3;
        post_scroll_gesture((int)dx, (int)dy, dur_ms, jitter);
        mark_self_input();
        write_ok(id, "");
        return;
    }

    // ── idle ──────────────────────────────────────────────────────────────────
    if (!strcmp(op, "idle")) {
        long sys_idle_ms = get_sys_idle_ms();
        double self_idle_s = (last_self_input == 0.0)
            ? 86400.0
            : mono_now() - last_self_input;
        long self_idle_ms = (long)(self_idle_s * 1000);

        // Mirror main.swift:451 — 50ms epsilon absorbs the lag between our
        // XTEST event and the screensaver counter update.
        int user_active = (sys_idle_ms + 50) < self_idle_ms;

        // Clamp to 86400000ms max (same cap as Swift helper).
        if (sys_idle_ms  > 86400000L) sys_idle_ms  = 86400000L;
        if (self_idle_ms > 86400000L) self_idle_ms = 86400000L;

        char buf[256];
        snprintf(buf, sizeof(buf),
                 "\"userActive\":%s,"
                 "\"userIdleMs\":%ld,"
                 "\"sysIdleMs\":%ld,"
                 "\"selfIdleMs\":%ld",
                 user_active ? "true" : "false",
                 user_active ? sys_idle_ms : 86400000L,
                 sys_idle_ms,
                 self_idle_ms);
        write_ok(id, buf);
        return;
    }

    // ── unknown ───────────────────────────────────────────────────────────────
    char errbuf[128];
    snprintf(errbuf, sizeof(errbuf), "unknown op: %s", op);
    write_fail(id, errbuf);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

int main(void) {
    // Seed RNG for humanization jitter.
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    srand((unsigned)(ts.tv_nsec ^ ts.tv_sec));

    const char *display_name = getenv("DISPLAY");
    dpy = XOpenDisplay(display_name);
    if (!dpy) {
        // Write a JSON error rather than silently dying — os.js reads stderr
        // but the ping sanity check (ReconInputClient.init) reads the first
        // stdout line. Emit a fail response so init surfaces the real error.
        printf("{\"id\":\"\",\"ok\":false,\"error\":\"cannot open X display: %s\"}\n",
               display_name ? display_name : "(not set)");
        fflush(stdout);
        return 1;
    }
    screen_num = DefaultScreen(dpy);
    root       = RootWindow(dpy, screen_num);

    // Verify XTEST is present (required for all input injection).
    int evt, err, major, minor;
    if (!XTestQueryExtension(dpy, &evt, &err, &major, &minor)) {
        printf("{\"id\":\"\",\"ok\":false,\"error\":\"XTEST extension not available\"}\n");
        fflush(stdout);
        return 1;
    }

    char line[65536];
    while (fgets(line, sizeof(line), stdin)) {
        // Strip trailing newline / CR.
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r'))
            line[--len] = '\0';
        if (!len) continue;
        handle(line);
    }

    XCloseDisplay(dpy);
    return 0;
}
