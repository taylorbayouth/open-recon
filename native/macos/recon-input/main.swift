// recon-input — macOS OS-level mouse/keyboard driver for Open Recon.
//
// Posts CGEvents at the HID-system level so the input is indistinguishable
// from a real mouse/keyboard to the in-page JavaScript world. Requires
// Accessibility permission for the calling process (Terminal, Node, etc.) in
// System Settings → Privacy & Security → Accessibility.
//
// Reads newline-delimited JSON commands on stdin, writes newline-delimited
// JSON responses on stdout. This avoids per-action process spawn overhead.
//
// Command shape:
//   { "id": "<corr>", "op": "move",   "x": 412, "y": 287,
//                     "speedPxPerSec": 1400, "jitterPx": 2 }
//   { "id": "<corr>", "op": "click",  "button": "left" }     // at current pos
//   { "id": "<corr>", "op": "down",   "button": "left" }
//   { "id": "<corr>", "op": "up",     "button": "left" }
//   { "id": "<corr>", "op": "type",   "text": "hello",
//                     "delayMsMin": 25, "delayMsMax": 85 }
//   { "id": "<corr>", "op": "key",    "key": "Return",
//                     "modifiers": ["cmd","shift"] }
//   { "id": "<corr>", "op": "scroll", "dx": 0, "dy": -120 }
//   { "id": "<corr>", "op": "pos" }                          // returns cursor
//   { "id": "<corr>", "op": "ping" }
//
// Response shape:
//   { "id": "<corr>", "ok": true,  "data": { ... } }
//   { "id": "<corr>", "ok": false, "error": "..." }

import Foundation
import CoreGraphics
import AppKit

// ─── JSON I/O ────────────────────────────────────────────────────────────────

func writeResponse(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func ok(_ id: String, _ data: [String: Any] = [:]) {
    writeResponse(["id": id, "ok": true, "data": data])
}

func fail(_ id: String, _ msg: String) {
    writeResponse(["id": id, "ok": false, "error": msg])
}

// ─── Mouse ───────────────────────────────────────────────────────────────────

func currentMousePos() -> CGPoint {
    return NSEvent.mouseLocation.flippedToCG()
}

extension NSPoint {
    // NSEvent.mouseLocation is in AppKit coords (origin bottom-left).
    // CGEvent uses Quartz coords (origin top-left).
    func flippedToCG() -> CGPoint {
        guard let screen = NSScreen.screens.first else { return CGPoint(x: x, y: y) }
        return CGPoint(x: x, y: screen.frame.height - y)
    }
}

func cgButton(_ name: String) -> CGMouseButton {
    switch name {
    case "right":  return .right
    case "center", "middle": return .center
    default:       return .left
    }
}

func mouseEventType(_ button: CGMouseButton, down: Bool) -> CGEventType {
    switch button {
    case .right:  return down ? .rightMouseDown : .rightMouseUp
    case .center: return down ? .otherMouseDown : .otherMouseUp
    default:      return down ? .leftMouseDown  : .leftMouseUp
    }
}

func postMouseMove(to p: CGPoint) {
    let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                     mouseCursorPosition: p, mouseButton: .left)
    ev?.post(tap: .cghidEventTap)
}

func postMouseButton(_ button: CGMouseButton, down: Bool, at p: CGPoint, clickCount: Int64 = 1) {
    let type = mouseEventType(button, down: down)
    let ev = CGEvent(mouseEventSource: nil, mouseType: type,
                     mouseCursorPosition: p, mouseButton: button)
    ev?.setIntegerValueField(.mouseEventClickState, value: clickCount)
    ev?.post(tap: .cghidEventTap)
}

// Humanlike motion: cubic Bezier from current → target with small random
// control-point offsets, jittered per-step. Duration is derived from distance
// and `speedPxPerSec`, with a 60Hz tick.
func humanMove(to target: CGPoint, speedPxPerSec: Double, jitterPx: Double) {
    let start = currentMousePos()
    let dx = target.x - start.x
    let dy = target.y - start.y
    let dist = sqrt(dx*dx + dy*dy)
    if dist < 0.5 {
        postMouseMove(to: target)
        return
    }

    let speed = max(speedPxPerSec, 50)
    let durationMs = (dist / speed) * 1000.0
    let frameMs: Double = 16.0
    let steps = max(2, Int(ceil(durationMs / frameMs)))

    // Two control points offset perpendicular to the direct path, with a
    // small random magnitude (~10% of distance). Keeps the curve subtle.
    let nx = -dy / dist
    let ny = dx / dist
    let sway = dist * 0.10 * Double.random(in: -1...1)
    let c1 = CGPoint(x: start.x + dx * 0.33 + nx * sway,
                     y: start.y + dy * 0.33 + ny * sway)
    let c2 = CGPoint(x: start.x + dx * 0.66 + nx * sway * 0.5,
                     y: start.y + dy * 0.66 + ny * sway * 0.5)

    for i in 1...steps {
        let t = Double(i) / Double(steps)
        // Ease-in-out so we don't snap to top speed instantly
        let te = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t
        let u = 1 - te
        let bx = u*u*u*start.x + 3*u*u*te*c1.x + 3*u*te*te*c2.x + te*te*te*target.x
        let by = u*u*u*start.y + 3*u*u*te*c1.y + 3*u*te*te*c2.y + te*te*te*target.y
        let jx = jitterPx > 0 ? Double.random(in: -jitterPx...jitterPx) : 0
        let jy = jitterPx > 0 ? Double.random(in: -jitterPx...jitterPx) : 0
        postMouseMove(to: CGPoint(x: bx + jx, y: by + jy))
        usleep(useconds_t(frameMs * 1000))
    }
    postMouseMove(to: target)
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

// Named-key → CGKeyCode. Covers the keys an agent realistically presses.
// Letter/number/punctuation keystrokes go through `type` (insertText path) so
// we don't need a full ANSI keymap here.
let NAMED_KEYS: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "space": 0x31,
    "delete": 0x33, "backspace": 0x33,
    "escape": 0x35, "esc": 0x35,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for n in names {
        switch n.lowercased() {
        case "cmd", "command", "meta": f.insert(.maskCommand)
        case "shift":                   f.insert(.maskShift)
        case "alt", "option":           f.insert(.maskAlternate)
        case "ctrl", "control":         f.insert(.maskControl)
        case "fn":                      f.insert(.maskSecondaryFn)
        default: break
        }
    }
    return f
}

func postKey(_ keyName: String, modifiers: [String]) -> String? {
    guard let code = NAMED_KEYS[keyName.lowercased()] else {
        return "unknown key: \(keyName)"
    }
    let flags = modifierFlags(modifiers)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up   = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    return nil
}

// Type Unicode text via keyboardSetUnicodeString — drives the same input
// pipeline as IME composition. Works for any character without a keymap.
func typeText(_ text: String, delayMsMin: Int, delayMsMax: Int) {
    for ch in text {
        let s = String(ch)
        let utf16 = Array(s.utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        let up   = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        utf16.withUnsafeBufferPointer { buf in
            down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buf.baseAddress)
            up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buf.baseAddress)
        }
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        let lo = max(0, min(delayMsMin, delayMsMax))
        let hi = max(lo, delayMsMax)
        let d = lo == hi ? lo : Int.random(in: lo...hi)
        if d > 0 { usleep(useconds_t(d * 1000)) }
    }
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

func postScroll(dx: Int32, dy: Int32) {
    // Pixel-precise scroll wheel event. `wheelCount: 2` to provide both axes.
    let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                     wheel1: dy, wheel2: dx, wheel3: 0)
    ev?.post(tap: .cghidEventTap)
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

func handle(_ cmd: [String: Any]) {
    let id = (cmd["id"] as? String) ?? ""
    guard let op = cmd["op"] as? String else { fail(id, "missing op"); return }

    switch op {
    case "ping":
        ok(id, ["pong": true])

    case "pos":
        let p = currentMousePos()
        ok(id, ["x": p.x, "y": p.y])

    case "move":
        guard let x = (cmd["x"] as? NSNumber)?.doubleValue,
              let y = (cmd["y"] as? NSNumber)?.doubleValue else {
            fail(id, "move requires x and y"); return
        }
        let speed = (cmd["speedPxPerSec"] as? NSNumber)?.doubleValue ?? 1400
        let jitter = (cmd["jitterPx"] as? NSNumber)?.doubleValue ?? 0
        humanMove(to: CGPoint(x: x, y: y), speedPxPerSec: speed, jitterPx: jitter)
        ok(id)

    case "click":
        let buttonName = (cmd["button"] as? String) ?? "left"
        let b = cgButton(buttonName)
        let p = currentMousePos()
        postMouseButton(b, down: true, at: p)
        postMouseButton(b, down: false, at: p)
        ok(id)

    case "down":
        let b = cgButton((cmd["button"] as? String) ?? "left")
        postMouseButton(b, down: true, at: currentMousePos())
        ok(id)

    case "up":
        let b = cgButton((cmd["button"] as? String) ?? "left")
        postMouseButton(b, down: false, at: currentMousePos())
        ok(id)

    case "type":
        guard let text = cmd["text"] as? String else { fail(id, "type requires text"); return }
        let lo = (cmd["delayMsMin"] as? NSNumber)?.intValue ?? 25
        let hi = (cmd["delayMsMax"] as? NSNumber)?.intValue ?? 85
        typeText(text, delayMsMin: lo, delayMsMax: hi)
        ok(id)

    case "key":
        guard let key = cmd["key"] as? String else { fail(id, "key requires key name"); return }
        let mods = (cmd["modifiers"] as? [String]) ?? []
        if let err = postKey(key, modifiers: mods) { fail(id, err); return }
        ok(id)

    case "scroll":
        let dx = (cmd["dx"] as? NSNumber)?.int32Value ?? 0
        let dy = (cmd["dy"] as? NSNumber)?.int32Value ?? 0
        postScroll(dx: dx, dy: dy)
        ok(id)

    default:
        fail(id, "unknown op: \(op)")
    }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        writeResponse(["id": "", "ok": false, "error": "invalid JSON"])
        continue
    }
    handle(cmd)
}
