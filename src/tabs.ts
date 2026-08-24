export type DocId = number;

export interface TabInfo {
  docId: DocId;
  path: string;
  fileName: string;
  label: string;
  marked: boolean; // 文件被删 / watch 失败的异常标记
}

export interface TabsState {
  tabs: TabInfo[];
  active: DocId | null;
}

// 纯派生副本：权威列表在 Rust，只由事件更新（唯一例外是切 tab 的本地先行）
let tabs: TabInfo[] = [];
let active: DocId | null = null;

/// 标签消歧：默认 fileName；重名时从路径末尾向前逐段追加（docs/README.md），
/// 直到组内互不相同或到根。
export function disambiguate(paths: string[]): string[] {
  const segs = paths.map((p) => p.split("/").filter(Boolean));
  const depth = segs.map(() => 1);
  const label = (i: number) => segs[i].slice(-depth[i]).join("/");
  // 上界防御：路径段耗尽后 changed 恒为 false，正常在此之前收敛
  for (let round = 0; round < 100; round++) {
    const groups = new Map<string, number[]>();
    segs.forEach((_, i) => {
      const l = label(i);
      groups.set(l, [...(groups.get(l) ?? []), i]);
    });
    let changed = false;
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      for (const i of idxs) {
        if (depth[i] < segs[i].length) {
          depth[i]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return segs.map((_, i) => label(i));
}

function emitChange(): void {
  const labels = disambiguate(tabs.map((t) => t.path));
  tabs.forEach((t, i) => (t.label = labels[i]));
  window.dispatchEvent(
    new CustomEvent<TabsState>("rsmd:tabs", {
      detail: { tabs: tabs.map((t) => ({ ...t })), active },
    })
  );
}

export function getTabs(): TabsState {
  return { tabs: tabs.map((t) => ({ ...t })), active };
}

export function addTab(docId: DocId, path: string, fileName: string): void {
  if (!tabs.some((t) => t.docId === docId)) {
    tabs.push({ docId, path, fileName, label: fileName, marked: false });
  }
  active = docId;
  emitChange();
}

export function setActiveTab(docId: DocId): void {
  if (!tabs.some((t) => t.docId === docId) || active === docId) return;
  active = docId;
  emitChange();
}

export function removeTab(docId: DocId, nextActive: DocId | null): void {
  const before = tabs.length;
  tabs = tabs.filter((t) => t.docId !== docId);
  if (tabs.length === before) return;
  if (active === docId) {
    active = nextActive !== null && tabs.some((t) => t.docId === nextActive) ? nextActive : null;
  }
  emitChange();
}

export function markTab(docId: DocId): void {
  const t = tabs.find((t) => t.docId === docId);
  if (!t || t.marked) return;
  t.marked = true;
  emitChange();
}

export function clearMark(docId: DocId): void {
  const t = tabs.find((t) => t.docId === docId);
  if (!t || !t.marked) return;
  t.marked = false;
  emitChange();
}
