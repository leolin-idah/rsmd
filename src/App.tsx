import { useEffect, useState } from "react";
import { PreviewPane } from "./preview/PreviewPane";
import { TabBar } from "./TabBar";
import { getTabs, type DocId, type TabsState } from "./tabs";

interface DocBannerDetail {
  docId: DocId;
  message: string;
}

export default function App() {
  const [globalBanner, setGlobalBanner] = useState<string | null>(null);
  // 横幅 per-doc：只渲染 active doc 的那一条；open-error 保持全局
  const [docBanners, setDocBanners] = useState<ReadonlyMap<DocId, string>>(new Map());
  // 初值直读 store：事件桥可能在本组件挂载前就收到首个 document-opened
  const [tabsState, setTabsState] = useState<TabsState>(getTabs);

  useEffect(() => {
    const onBanner = (e: Event) => setGlobalBanner((e as CustomEvent<string>).detail);
    const onBannerClear = () => setGlobalBanner(null);
    const onDocBanner = (e: Event) => {
      const d = (e as CustomEvent<DocBannerDetail>).detail;
      setDocBanners((prev) => new Map(prev).set(d.docId, d.message));
    };
    const onDocBannerClear = (e: Event) => {
      const d = (e as CustomEvent<{ docId: DocId }>).detail;
      setDocBanners((prev) => {
        if (!prev.has(d.docId)) return prev;
        const next = new Map(prev);
        next.delete(d.docId);
        return next;
      });
    };
    const onTabs = (e: Event) => setTabsState((e as CustomEvent<TabsState>).detail);
    window.addEventListener("rsmd:banner", onBanner);
    window.addEventListener("rsmd:banner-clear", onBannerClear);
    window.addEventListener("rsmd:doc-banner", onDocBanner);
    window.addEventListener("rsmd:doc-banner-clear", onDocBannerClear);
    window.addEventListener("rsmd:tabs", onTabs);
    return () => {
      window.removeEventListener("rsmd:banner", onBanner);
      window.removeEventListener("rsmd:banner-clear", onBannerClear);
      window.removeEventListener("rsmd:doc-banner", onDocBanner);
      window.removeEventListener("rsmd:doc-banner-clear", onDocBannerClear);
      window.removeEventListener("rsmd:tabs", onTabs);
    };
  }, []);

  const hasDoc = tabsState.tabs.length > 0;
  const banner =
    globalBanner ??
    (tabsState.active !== null ? (docBanners.get(tabsState.active) ?? null) : null);

  return (
    <div id="shell">
      {hasDoc && <TabBar tabs={tabsState.tabs} active={tabsState.active} />}
      <div id="main">
        {banner && <div className="banner">{banner}</div>}
        {!hasDoc && (
          <p className="welcome">Open a Markdown file (⌘O) or drop it here.</p>
        )}
        <PreviewPane />
      </div>
    </div>
  );
}
