import type { DocMode } from "../ipc";

/// 文本权威与脏判定的纯状态机（设计 §4）。不持有编辑器：所有判断以 Engines 提供的当前值为输入，
/// 由 mdEditor.ts 驱动；副作用（灌文本 / 重解析）也经 Engines 执行，便于用假引擎单测。
export interface DocModel {
  mode: DocMode;
  /// 磁盘上我们最近一次看到 / 写入的文本（与 Rust 的 disk_hash 对应）
  savedText: string;
  /// 与 savedText 对应的 ProseMirror 序列化结果；null = PM 内容落后于 savedText
  /// （在 source 里保存过 / 外部更新落在 source 上），下次进入 PM 模式时整文重载
  pmSavedMarkdown: string | null;
  /// 进入 source 时灌入 CM 的文本；null = 尚未进过 source
  cmEnteredText: string | null;
}

export interface Engines {
  pmMarkdown(): string;
  pmNormalize(text: string): string;
  pmReplace(text: string): void;
  cmText(): string;
  cmSet(text: string): void;
  cmApplyDiff(text: string): void;
}

export function initialModel(text: string, e: Engines): DocModel {
  return { mode: "preview", savedText: text, pmSavedMarkdown: e.pmMarkdown(), cmEnteredText: null };
}

/// 脏 = 保存会改变文件。source 按字节比；PM 模式比序列化结果——doc.eq 会被 heading id / 列表序号回填干扰
export function isDirty(m: DocModel, e: Engines): boolean {
  if (m.mode === "source") return e.cmText() !== m.savedText;
  return m.pmSavedMarkdown !== null && e.pmMarkdown() !== m.pmSavedMarkdown;
}

export function textForSave(m: DocModel, e: Engines): string {
  return m.mode === "source" ? e.cmText() : e.pmMarkdown();
}

/// 设计 §4.2：→ source 交接文本；source → PM 视情况重解析；preview ↔ live 只改 mode（editable 由调用方切）
export function switchMode(m: DocModel, e: Engines, next: DocMode): DocModel {
  if (next === m.mode) return m;
  if (next === "source") {
    const t = isDirty(m, e) ? e.pmMarkdown() : m.savedText;
    e.cmSet(t);
    return { ...m, mode: "source", cmEnteredText: t };
  }
  if (m.mode === "source") {
    const cm = e.cmText();
    let pmSavedMarkdown = m.pmSavedMarkdown;
    if (pmSavedMarkdown === null || cm !== m.cmEnteredText) {
      e.pmReplace(cm);
      if (pmSavedMarkdown === null) pmSavedMarkdown = e.pmNormalize(m.savedText);
    }
    return { ...m, mode: next, pmSavedMarkdown };
  }
  return { ...m, mode: next };
}

/// 保存成功后：source 下 PM 落后于磁盘（置 null）；PM 模式下基线就是刚写进磁盘的那份文本。
/// 这里刻意不按设计 §4.2 写 `e.getMarkdown()`：保存是一次 IPC 往返，期间用户可能又敲了几下，
/// 回来再序列化一次会把那些改动一起吸进"干净基线"（● 消失、⌘W 守卫放行、改动丢失）；
/// 而且 savedText 本来就是 textForSave() 的结果，重算一遍纯属多花一次整篇序列化。
/// `_e` 只为与 docModel 其余函数保持同一签名（调用方统一传引擎），本函数不需要引擎
export function afterSave(m: DocModel, _e: Engines, savedText: string): DocModel {
  return m.mode === "source"
    ? { ...m, savedText, pmSavedMarkdown: null }
    : { ...m, savedText, pmSavedMarkdown: savedText };
}

/// 外部更新（不脏；脏时由调用方挂冲突横幅，不进这里）
export function applyExternal(m: DocModel, e: Engines, text: string): DocModel {
  if (m.mode === "source") {
    e.cmApplyDiff(text);
    return { ...m, savedText: text, cmEnteredText: text, pmSavedMarkdown: null };
  }
  e.pmReplace(text);
  return { ...m, savedText: text, pmSavedMarkdown: e.pmMarkdown() };
}
