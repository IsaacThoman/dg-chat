import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { strToU8, zipSync } from "fflate";
import {
  DocumentExtractionError,
  extractDocument,
  extractDocx,
  extractPdf,
  reconstructPdfText,
} from "./document-extraction.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const rels = (body: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;

function utf16(value: string, endian: "le" | "be"): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes.set(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(2 + index * 2, value.charCodeAt(index), endian === "le");
  }
  return bytes;
}

function docx(
  documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body><w:p><w:r><w:t>First page &amp; notes</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
    <w:p><w:r><w:t>Second section</w:t></w:r></w:p></w:body></w:document>`,
  extra: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
       <Override PartName="/word/document.xml"
       ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
       </Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
    "word/document.xml": strToU8(documentXml),
    ...extra,
  }, { level: 6 });
}

function pdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const add = (body: string): number => (objects.push(body), objects.length);
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    ));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
    `/Count ${pageIds.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(
    "",
  );
  output += `trailer\n<< /Size ${
    objects.length + 1
  } /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(output);
}

function centralOffset(bytes: Uint8Array, entry = 0): number {
  let found = 0;
  for (let offset = 0; offset <= bytes.length - 4; offset++) {
    if (
      bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x01 &&
      bytes[offset + 3] === 0x02
    ) {
      if (found++ === entry) return offset;
    }
  }
  throw new Error("central entry not found");
}

function centralOffsetForName(bytes: Uint8Array, expected: string): number {
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (
      bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x01 &&
      bytes[offset + 3] === 0x02
    ) {
      const nameLength = bytes[offset + 28] | bytes[offset + 29] << 8;
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name === expected) return offset;
    }
  }
  throw new Error(`central entry not found: ${expected}`);
}

function setU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
  bytes[offset + 2] = value >>> 16 & 255;
  bytes[offset + 3] = value >>> 24 & 255;
}

async function rejectsCode(
  operation: () => Promise<unknown>,
  code: DocumentExtractionError["code"],
): Promise<void> {
  const error = await assertRejects(operation, DocumentExtractionError);
  assertEquals(error.code, code);
}

Deno.test("PDF extraction preserves page text, count, and page metadata", async () => {
  const result = await extractPdf(pdf(["Alpha", "Beta"]));
  assertEquals(result.text, "Alpha\n\nBeta");
  assertEquals(result.metadata.pageCount, 2);
  assertEquals(result.units.map((unit) => unit.metadata.pageNumber), [1, 2]);
  assertEquals(result.units.map((unit) => unit.kind), ["page", "page"]);
});

Deno.test("PDF hasEOL inserts a line break after the flagged item", () => {
  assertEquals(
    reconstructPdfText([
      { str: "First", hasEOL: true, transform: [1, 0, 0, 1, 0, 20] },
      { str: "Second", hasEOL: false, transform: [1, 0, 0, 1, 0, 20] },
      { str: "line", hasEOL: false, transform: [1, 0, 0, 1, 10, 20] },
    ]),
    "First\nSecond line",
  );
});

Deno.test("PDF extraction rejects raw, page, output, timeout, and malformed inputs", async () => {
  const valid = pdf(["one", "two"]);
  await rejectsCode(
    () => extractPdf(valid, { maxRawBytes: valid.length - 1 }),
    "raw_bytes_exceeded",
  );
  await rejectsCode(() => extractPdf(valid, { maxPdfPages: 1 }), "pdf_pages_exceeded");
  await rejectsCode(() => extractPdf(valid, { maxOutputCharacters: 2 }), "output_exceeded");
  await rejectsCode(() => extractPdf(valid, { timeoutMs: 0 }), "time_exceeded");
  await rejectsCode(() => extractPdf(strToU8("not a pdf")), "invalid_pdf");
});

Deno.test("DOCX extraction preserves section boundaries and decodes OOXML text", async () => {
  const result = await extractDocument(docx(), DOCX);
  assertEquals(result.text, "First page & notes\n\nSecond section");
  assertEquals(result.metadata.sectionCount, 2);
  assertEquals(result.units.map((unit) => unit.metadata.sectionNumber), [1, 2]);
  assertEquals(result.units.map((unit) => unit.kind), ["section", "section"]);
});

Deno.test("DOCX extraction defers paragraph section breaks and preserves Word controls", async () => {
  const result = await extractDocx(docx(
    `<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<x:body>` +
      `<x:p><x:r><x:t>First</x:t></x:r></x:p>` +
      `<x:p><x:pPr><x:sectPr/></x:pPr>` +
      `<x:r><x:t>Last</x:t><x:t xml:space="preserve"> run</x:t><x:tab/>` +
      `<x:t>tab</x:t><x:br/><x:t>after</x:t><x:cr/><x:t>end</x:t></x:r></x:p>` +
      `<x:p><x:r><x:t>Second</x:t><x:t>A</x:t></x:r><x:r><x:t>B</x:t></x:r></x:p>` +
      `<x:sectPr/>` +
      `</x:body></x:document>`,
  ));
  assertEquals(result.text, "First\nLast run\ttab\nafter\nend\n\nSecondAB");
  assertEquals(result.units.map((unit) => unit.text), [
    "First\nLast run\ttab\nafter\nend",
    "SecondAB",
  ]);
  assertEquals(result.units.map((unit) => unit.metadata.sectionNumber), [1, 2]);
});

Deno.test("DOCX rejects excessive raw bytes, output, entries, and elapsed deadline", async () => {
  const valid = docx();
  await rejectsCode(
    () => extractDocx(valid, { maxRawBytes: valid.length - 1 }),
    "raw_bytes_exceeded",
  );
  await rejectsCode(() => extractDocx(valid, { maxOutputCharacters: 3 }), "output_exceeded");
  await rejectsCode(() => extractDocx(valid, { maxZipEntries: 1 }), "zip_entries_exceeded");
  await rejectsCode(() => extractDocx(valid, { timeoutMs: 0 }), "time_exceeded");
});

Deno.test("DOCX preflight rejects oversized entries and total expansion before inflate", async () => {
  const valid = docx();
  await rejectsCode(() => extractDocx(valid, { maxZipEntryBytes: 5 }), "zip_entry_exceeded");
  await rejectsCode(
    () => extractDocx(valid, { maxZipExpandedBytes: 100 }),
    "zip_expansion_exceeded",
  );
});

Deno.test("DOCX preflight rejects deceptive compression ratios", async () => {
  const hostile = docx(undefined, { "word/large.xml": new Uint8Array(20_000) });
  await rejectsCode(
    () => extractDocx(hostile, { maxZipCompressionRatio: 10 }),
    "zip_ratio_exceeded",
  );
});

Deno.test("DOCX preflight rejects traversal and absolute entry names", async () => {
  for (const name of ["../evil", "/absolute", "C:/drive", "word\\evil.xml", "word/./evil.xml"]) {
    await rejectsCode(
      () => extractDocx(docx(undefined, { [name]: strToU8("x") })),
      "zip_path_traversal",
    );
  }
});

Deno.test("DOCX preflight rejects encrypted central-directory flags", async () => {
  const hostile = docx().slice();
  const central = centralOffset(hostile);
  setU16(hostile, central + 8, 1);
  await rejectsCode(() => extractDocx(hostile), "zip_encrypted");
});

Deno.test("DOCX preflight distrusts forged expansion sizes", async () => {
  const oversized = docx().slice();
  setU32(oversized, centralOffset(oversized) + 24, 30_000_000);
  await rejectsCode(() => extractDocx(oversized), "zip_entry_exceeded");

  const ratio = docx().slice();
  const central = centralOffset(ratio);
  setU32(ratio, central + 20, 1);
  setU32(ratio, central + 24, 1_000);
  await rejectsCode(() => extractDocx(ratio, { maxZipCompressionRatio: 20 }), "zip_ratio_exceeded");
});

Deno.test("DOCX validates actual inflated sizes rather than trusting forged small metadata", async () => {
  const hostile = docx(undefined, { "word/large.xml": new Uint8Array(40_000) }).slice();
  const central = centralOffsetForName(hostile, "word/large.xml");
  setU32(hostile, central + 24, 1);
  const local = hostile[central + 42] | hostile[central + 43] << 8 |
    hostile[central + 44] << 16 | hostile[central + 45] << 24;
  setU32(hostile, local + 22, 1);
  await rejectsCode(
    () => extractDocx(hostile, { maxZipEntryBytes: 10_000, maxZipCompressionRatio: 1_000 }),
    "zip_entry_exceeded",
  );
});

Deno.test("DOCX verifies local compression methods and actual CRC integrity", async () => {
  const methodMismatch = docx().slice();
  const methodCentral = centralOffsetForName(methodMismatch, "word/document.xml");
  setU16(methodMismatch, methodCentral + 10, 0);
  await rejectsCode(() => extractDocx(methodMismatch), "invalid_docx");

  const badCrc = docx().slice();
  const crcCentral = centralOffsetForName(badCrc, "word/document.xml");
  const local = (badCrc[crcCentral + 42] | badCrc[crcCentral + 43] << 8 |
    badCrc[crcCentral + 44] << 16 | badCrc[crcCentral + 45] << 24) >>> 0;
  const forgedCrc = 0x12345678;
  setU32(badCrc, crcCentral + 16, forgedCrc);
  setU32(badCrc, local + 14, forgedCrc);
  await rejectsCode(() => extractDocx(badCrc), "invalid_docx");
});

Deno.test("DOCX rejects macros declared by files or content types", async () => {
  await rejectsCode(
    () => extractDocx(docx(undefined, { "word/vbaProject.bin": strToU8("macro") })),
    "docx_macro",
  );
  const macroTypes =
    `<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`;
  const hostile = docx(undefined, {
    "[Content_Types].xml": strToU8(macroTypes),
    "word/document.xml": strToU8(`<w:document><w:body/></w:document>`),
  });
  await rejectsCode(() => extractDocx(hostile), "docx_macro");
});

Deno.test("DOCX rejects embedded, ActiveX, executable, and custom UI parts", async () => {
  for (
    const name of [
      "word/embeddings/oleObject1.bin",
      "word/activeX/activeX1.bin",
      "customUI/customUI.xml",
      "word/embeddings/payload.exe",
    ]
  ) {
    await rejectsCode(
      () => extractDocx(docx(undefined, { [name]: strToU8("active") })),
      "docx_active_content",
    );
  }
});

Deno.test("DOCX requires canonical package names and rejects DDE field instructions", async () => {
  const alternateCase = zipSync({
    "[CONTENT_TYPES].XML": strToU8("<Types/>"),
    "word/document.xml": strToU8("<w:document><w:body/></w:document>"),
  });
  await rejectsCode(() => extractDocx(alternateCase), "invalid_docx");

  for (
    const field of [
      '<w:instrText xml:space="preserve"> DDEAUTO c:\\windows\\system32\\cmd.exe </w:instrText>',
      '<w:fldSimple w:instr="DDE server topic"/>',
      "<w:instrText>DD</w:instrText><w:instrText>EAUTO command</w:instrText>",
      "<w:instrText>D&#68;E command</w:instrText>",
    ]
  ) {
    await rejectsCode(
      () =>
        extractDocx(docx(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${field}</w:body></w:document>`,
        )),
      "docx_active_content",
    );
  }
});

Deno.test("DOCX rejects split active fields and objects in every Word XML story part", async () => {
  for (
    const [name, xml] of [
      [
        "word/header1.xml",
        `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:instrText>DD</w:instrText><w:instrText>EAUTO command</w:instrText></w:hdr>`,
      ],
      [
        "word/footer1.xml",
        `<x:ftr xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:fldSimple x:instr="D&#68;E command"/></x:ftr>`,
      ],
      [
        "word/footnotes.xml",
        `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:object/></w:footnotes>`,
      ],
    ] as const
  ) {
    await rejectsCode(
      () =>
        extractDocx(docx(undefined, {
          [name]: strToU8(xml),
          "word/_rels/document.xml.rels": strToU8(
            rels(`<Relationship Target="${name.slice("word/".length)}"/>`),
          ),
        })),
      "docx_active_content",
    );
  }
});

Deno.test("DOCX scans relationship-selected Office XML without flagging unrelated custom XML", async () => {
  const unrelated = await extractDocx(docx(undefined, {
    "custom/unrelated.xml": strToU8(
      `<x:data xmlns:x="urn:example"><x:instrText>DDEAUTO harmless data</x:instrText><x:object/></x:data>`,
    ),
  }));
  assertEquals(unrelated.mimeType, DOCX);
  for (
    const [name, xml] of [
      [
        "custom/story.xml",
        `<x:story xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:instrText>DDEAUTO command</x:instrText></x:story>`,
      ],
      [
        "Stories/header.xml",
        `<prefix-with-dash:object xmlns:prefix-with-dash="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      ],
      [
        "custom/footer.xml",
        `<prefix.with.dot:OLEObject xmlns:prefix.with.dot="urn:schemas-microsoft-com:office:office"/>`,
      ],
    ] as const
  ) {
    await rejectsCode(
      () =>
        extractDocx(docx(undefined, {
          [name]: strToU8(xml),
          "word/_rels/document.xml.rels": strToU8(
            rels(`<Relationship Target="../${name}"/>`),
          ),
        })),
      "docx_active_content",
    );
  }
});

Deno.test("DOCX relationship graph requires canonical root, rejects traversal, and bounds cycles", async () => {
  await rejectsCode(
    () =>
      extractDocx(docx(undefined, {
        "_rels/.rels": strToU8(
          rels(`<Relationship Type="urn:test/officeDocument" Target="custom/main.xml"/>`),
        ),
      })),
    "invalid_docx",
  );
  await rejectsCode(
    () =>
      extractDocx(docx(undefined, {
        "word/_rels/document.xml.rels": strToU8(
          rels(`<Relationship Target="../../outside.xml"/>`),
        ),
      })),
    "invalid_docx",
  );
  const cyclic = await extractDocx(docx(undefined, {
    "word/_rels/document.xml.rels": strToU8(
      rels(`<Relationship Target="header1.xml"/>`),
    ),
    "word/header1.xml": strToU8(
      `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">safe</w:hdr>`,
    ),
    "word/_rels/header1.xml.rels": strToU8(
      rels(`<Relationship Target="document.xml"/>`),
    ),
  }));
  assertEquals(cyclic.mimeType, DOCX);
});

Deno.test("DOCX parser honors Unicode prefixes and namespace rebinding without comment false positives", async () => {
  await rejectsCode(
    () =>
      extractDocx(docx(undefined, {
        "word/header-unicode.xml": strToU8(
          `<文:hdr xmlns:文="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><文:instrText>DDEAUTO command</文:instrText></文:hdr>`,
        ),
        "word/_rels/document.xml.rels": strToU8(
          rels(`<Relationship Target="header-unicode.xml"/>`),
        ),
      })),
    "docx_active_content",
  );
  const safe = await extractDocx(docx(undefined, {
    "word/header-safe.xml": strToU8(
      `<x:hdr xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<!-- <x:instrText>DDEAUTO comment</x:instrText> -->` +
        `<safe xmlns:x="urn:unrelated"><x:instrText>DDEAUTO data</x:instrText><x:object/></safe>` +
        `</x:hdr>`,
    ),
    "word/_rels/document.xml.rels": strToU8(rels(`<Relationship Target="header-safe.xml"/>`)),
  }));
  assertEquals(safe.mimeType, DOCX);
});

Deno.test("DOCX parser rejects malformed reachable XML", async () => {
  await rejectsCode(
    () =>
      extractDocx(docx(undefined, {
        "word/header-broken.xml": strToU8(
          `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>`,
        ),
        "word/_rels/document.xml.rels": strToU8(
          rels(`<Relationship Target="header-broken.xml"/>`),
        ),
      })),
    "invalid_docx",
  );
});

Deno.test("DOCX parser supports fatal UTF-16LE and UTF-16BE package XML", async () => {
  const root = `<?xml version="1.0" encoding="UTF-16"?>` + rels(
    `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`,
  );
  const document = `<?xml version="1.0" encoding="UTF-16LE"?>` +
    `<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<body><p><r><t>UTF sixteen text</t></r></p></body></document>`;
  const result = await extractDocx(docx(undefined, {
    "_rels/.rels": utf16(root, "be"),
    "word/document.xml": utf16(document, "le"),
  }));
  assertEquals(result.text, "UTF sixteen text");

  const mismatch = docx(undefined, {
    "word/document.xml": utf16(document.replace("UTF-16LE", "UTF-8"), "le"),
  });
  await rejectsCode(() => extractDocx(mismatch), "invalid_docx");
});

Deno.test("DOCX rejects dense, deeply nested, and excessive aggregate XML before retention", async () => {
  const dense = docx(undefined, {
    "custom/dense.xml": strToU8(`<root>${"<x/>".repeat(100_001)}</root>`),
  });
  await rejectsCode(
    () => extractDocx(dense, { maxZipCompressionRatio: 1_000_000 }),
    "invalid_docx",
  );

  const deep = `<root>${"<x>".repeat(300)}value${"</x>".repeat(300)}</root>`;
  await rejectsCode(
    () =>
      extractDocx(
        docx(undefined, {
          "custom/deep.xml": strToU8(deep),
          "word/_rels/document.xml.rels": strToU8(
            rels(`<Relationship Target="../custom/deep.xml"/>`),
          ),
        }),
        {
          maxZipCompressionRatio: 1_000_000,
        },
      ),
    "invalid_docx",
  );

  const largeParts: Record<string, Uint8Array> = {};
  for (let index = 0; index < 5; index++) {
    largeParts[`custom/large-${index}.xml`] = strToU8(`<root>${"x".repeat(3_500_000)}</root>`);
  }
  await rejectsCode(
    () =>
      extractDocx(docx(undefined, largeParts), {
        maxRawBytes: 25 * 1024 * 1024,
        maxZipEntryBytes: 5 * 1024 * 1024,
        maxZipCompressionRatio: 1_000_000,
      }),
    "invalid_docx",
  );
});

Deno.test("DOCX rejects active internal relationship types regardless of target filename", async () => {
  for (const type of ["oleObject", "package", "attachedTemplate", "control"]) {
    const relationshipXml = rels(
      `<Relationship ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" ` +
        `Target="../media/innocent.bin"/>`,
    );
    await rejectsCode(
      () =>
        extractDocx(docx(undefined, {
          "word/_rels/document.xml.rels": strToU8(relationshipXml),
          "word/media/innocent.bin": strToU8("payload"),
        })),
      "docx_active_content",
    );
  }
});

Deno.test("DOCX rejects entity declarations that could obscure active instructions", async () => {
  await rejectsCode(
    () =>
      extractDocx(docx(
        `<!DOCTYPE w:document [<!ENTITY cmd "DDEAUTO">]>` +
          `<w:document><w:body><w:instrText>&cmd; command</w:instrText></w:body></w:document>`,
      )),
    "docx_active_content",
  );
});

Deno.test("DOCX rejects external relationships regardless of target scheme", async () => {
  for (const target of ["https://attacker.invalid/x", "file:///etc/passwd", "\\\\server\\share"]) {
    const relationshipXml = rels(
      `<Relationship Target="${target}" TargetMode="External"/>`,
    );
    await rejectsCode(
      () =>
        extractDocx(docx(undefined, {
          "word/_rels/document.xml.rels": strToU8(relationshipXml),
        })),
      "docx_external_reference",
    );
  }
});

Deno.test("DOCX rejects missing, malformed, and non-ZIP documents with typed errors", async () => {
  await rejectsCode(() => extractDocx(strToU8("not zip")), "invalid_docx");
  await rejectsCode(
    () => extractDocx(zipSync({ "[Content_Types].xml": strToU8("<Types/>") })),
    "invalid_docx",
  );
  await rejectsCode(
    () => extractDocx(docx("<not-document/>")),
    "invalid_docx",
  );
});

Deno.test("dispatcher rejects unsupported MIME types with a stable typed code", async () => {
  await rejectsCode(
    () => extractDocument(new Uint8Array(), "application/octet-stream"),
    "unsupported_type",
  );
});
