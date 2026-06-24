import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractOfficeText, extractOfficeXmlText } from "./office";

describe("extractOfficeXmlText", () => {
  it("joins text runs and breaks on paragraphs", () => {
    const xml = `<w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:body>`;
    expect(extractOfficeXmlText(xml)).toBe("Hello world\nLine two");
  });

  it("decodes XML entities", () => {
    expect(extractOfficeXmlText(`<a:t>A &amp; B &lt;3</a:t>`)).toBe("A & B <3");
  });

  it("ignores non-text tags like w:tbl", () => {
    expect(extractOfficeXmlText(`<w:tbl></w:tbl><w:p></w:p>`)).toBe("");
  });
});

describe("extractOfficeText", () => {
  it("reads a docx's document text", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p></w:body></w:document>`);
    const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    expect(await extractOfficeText("docx", buffer)).toBe("Quarterly report");
  });

  it("reads pptx slides in slide-number order", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", `<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`);
    zip.file("ppt/slides/slide1.xml", `<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>`);
    const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    expect(await extractOfficeText("pptx", buffer)).toBe("First\n\nSecond");
  });

  it("reads xlsx shared strings", async () => {
    const zip = new JSZip();
    zip.file("xl/sharedStrings.xml", `<sst><si><t>Name</t></si><si><t>Total</t></si></sst>`);
    const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    expect(await extractOfficeText("xlsx", buffer)).toBe("Name\nTotal");
  });
});
