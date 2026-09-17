//! macOS 红绿灯垂直居中到 40px 的 tab 条。
//! tao 的 trafficLightPosition 只在内容视图 drawRect 里贴一次，macOS 26 每次 resize 布局
//! 又把按钮重置回系统默认（圆心距顶 16pt），WebView 自绘后也不再触发重绘，等于没生效。
//! 所以自己直接改三个按钮的 origin.y，并在 Resized / Focused / 改标题等会触发重排的时机后重贴。

use dispatch2::DispatchQueue;
use objc2_app_kit::{NSWindow, NSWindowButton};

/// 与 theme.css 的 --rsmd-header-h 保持一致
const HEADER_H: f64 = 40.0;

pub fn center(window: &tauri::Window) {
    let Ok(ptr) = window.ns_window() else { return };
    // SAFETY: ns_window 返回本窗口存活的 NSWindow*；setup 与 on_window_event 都在主线程
    let ns_window: &NSWindow = unsafe { &*ptr.cast() };
    let kinds = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ];
    for kind in kinds {
        let Some(button) = ns_window.standardWindowButton(kind) else {
            continue;
        };
        // SAFETY: 标准按钮始终挂在 NSTitlebarView 下
        let Some(titlebar) = (unsafe { button.superview() }) else {
            continue;
        };
        let mut frame = button.frame();
        // AppKit y 轴向上：圆心落在标题栏顶部往下 HEADER_H/2 处；x 保留系统默认
        let y = titlebar.frame().size.height - HEADER_H / 2.0 - frame.size.height / 2.0;
        if (frame.origin.y - y).abs() > 0.01 {
            frame.origin.y = y;
            button.setFrameOrigin(frame.origin);
        }
    }
}

/// 改标题后调用。tao 的 set_title 是把 `setTitle:` 异步丢到 GCD 主队列，而 `setTitle:` 又会
/// 复位红绿灯，同步重贴会跑在它前面白贴；排进同一个串行主队列就一定落在它之后。
pub fn center_after_title(window: tauri::Window) {
    DispatchQueue::main().exec_async(move || center(&window));
}
