import { imageSchema } from "@milkdown/preset-commonmark";
import type { Node as PmNode } from "@milkdown/prose/model";
import type { NodeView } from "@milkdown/prose/view";
import { $ctx, $view } from "@milkdown/utils";
import { assetUrl } from "../../ipc";
import type { Feature } from "../pmEditor";

/// posix 拼接并规范化 `.` / `..`；结果恒以 / 开头
export function joinPosix(base: string, rel: string): string {
  const out: string[] = [];
  for (const p of `${base}/${rel}`.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

/// 相对路径按文档目录拼接、绝对路径原样，再经 asset protocol；带协议的（http(s): data: file:）不动。
/// 只影响渲染用的 src，模型里的属性保持原文
export function resolveImageSrc(src: string, baseDir: string): string {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  return assetUrl(src.startsWith("/") ? src : joinPosix(baseDir, src));
}

export function localImageFeature(baseDir: string): Feature {
  // baseDir 随文档不同，作为该实例私有的 ctx 切片；不用模块级变量，多 tab 才不会串
  const baseDirCtx = $ctx({ baseDir }, "rsmdBaseDir");
  const imageView = $view(imageSchema.node, (ctx) => (node): NodeView => {
    const img = document.createElement("img");
    img.className = "rsmd-image";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.dataset.error = "true";
    });
    // 记住上一次解析出的 src：alt/title 之类的属性变化会走同一个 apply()，
    // 但如果 src 没变就不该重新 setAttribute——浏览器对相同 src 不会重新加载图片、
    // 也不会再触发 error 事件，若照旧每次都清 data-error，已损坏图片的错误态会被清空且永远回不来
    let currentSrc: string | null = null;
    const apply = (n: PmNode): void => {
      const src = String(n.attrs.src ?? "");
      img.alt = String(n.attrs.alt ?? "");
      img.title = String(n.attrs.title ?? "");
      img.dataset.raw = src;
      const resolved = resolveImageSrc(src, ctx.get(baseDirCtx.key).baseDir);
      if (resolved !== currentSrc) {
        delete img.dataset.error;
        img.setAttribute("src", resolved);
        currentSrc = resolved;
      }
    };
    apply(node);
    return {
      dom: img,
      update(n) {
        if (n.type !== node.type) return false;
        apply(n);
        return true;
      },
      ignoreMutation: () => true,
    };
  });
  return { plugins: [baseDirCtx, imageView] };
}
