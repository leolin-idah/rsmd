import { memo, useEffect, useRef } from "react";
import { attachHost } from "./document";
import { installLinkHandler } from "./links";

// 非 React 孤岛：#panes 宿主交给 dom 层后 React 永不重渲此组件，
// pane 的增删显隐全部由 document.ts 管理（spec §3）
export const PreviewPane = memo(function PreviewPane() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      attachHost(ref.current);
      installLinkHandler(ref.current);
    }
  }, []);
  return <div ref={ref} id="panes" />;
});
