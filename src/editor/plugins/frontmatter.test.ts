import { afterEach, describe, expect, it } from "vitest";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { frontmatterFeature } from "./frontmatter";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});
async function open(text: string): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable: true, features: [frontmatterFeature] });
  return editor;
}

const MD = "---\ntitle: Front matter\ntags: [a, b]\n---\n\n# Heading\n";

describe("frontmatter", () => {
  it("round-trips YAML front matter verbatim", async () => {
    const e = await open(MD);
    expect(e.getMarkdown().trim()).toBe(MD.trim());
  });

  it("renders it as a muted source block ahead of the content", async () => {
    const e = await open(MD);
    const block = e.view().dom.querySelector<HTMLElement>('pre.rsmd-frontmatter[data-type="frontmatter"]')!;
    expect(block.querySelector("code")?.textContent).toBe("title: Front matter\ntags: [a, b]");
    expect(block.nextElementSibling?.tagName).toBe("H1");
  });

  it("is not confused by a thematic break later in the document", async () => {
    const e = await open("para\n\n---\n\nafter\n");
    expect(e.view().dom.querySelector(".rsmd-frontmatter")).toBeNull();
    expect(e.getMarkdown().trim()).toBe("para\n\n---\n\nafter");
  });
});
