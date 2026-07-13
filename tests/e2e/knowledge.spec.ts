import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { Buffer } from "node:buffer";
import { apiURL, bootstrap, createChat, login, openSidebar } from "./helpers.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function documentPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${
      `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`.length
    } >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 6\n0000000000 65535 f \n${
    offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  }trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

function documentDocx(first: string, second: string): Buffer {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${first}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr><w:p><w:r><w:t>${second}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }, { level: 6 }));
}

test.beforeEach(async ({ page, request }) => {
  await bootstrap(request);
  await login(page);
  await createChat(page);
});

const workspaceNavigation = (page: import("@playwright/test").Page) =>
  page.getByLabel("Workspace navigation", { exact: true });

test("manages a collection and persists conversation knowledge", async ({ page }, testInfo) => {
  const suffix = `${Date.now()}-${testInfo.project.name}`;
  const originalName = `Knowledge ${suffix}`;
  const renamedName = `Product docs ${suffix}`;
  const filename = `knowledge-${suffix}.txt`;

  // Exercise the real upload and ingestion path so the collection can only accept a genuinely
  // ready, owner-scoped attachment. The worker updates this status asynchronously.
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(`DG Chat knowledge browser test document ${suffix}.`),
  });
  await expect.poll(async () => {
    const response = await page.request.get(`${apiURL}/api/attachments`);
    if (!response.ok()) return "unavailable";
    const body = await response.json() as {
      data: Array<{ filename: string; ingestionStatus?: string }>;
    };
    return body.data.find((attachment) => attachment.filename === filename)?.ingestionStatus ??
      "missing";
  }, { timeout: 30_000 }).toBe("ready");

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", {
    name: "Knowledge",
    exact: true,
  }).click();
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();

  const create = page.getByRole("button", { name: "Create collection" });
  await create.click();
  await page.getByRole("dialog", { name: "New collection" }).getByLabel("Name").fill(originalName);
  await page.getByRole("dialog", { name: "New collection" })
    .getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: originalName })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename collection" });
  await renameDialog.getByLabel("Name").fill(renamedName);
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeVisible();

  await page.getByRole("button", { name: "Add uploaded file" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add an uploaded file" });
  await addDialog.getByRole("radio", { name: new RegExp(filename) }).check();
  await addDialog.getByRole("button", { name: "Add file" }).click();
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge-list nav button.active")).toContainText(
    "1 file",
  );

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", { name: "Chats", exact: true })
    .click();
  const knowledgeTrigger = page.getByRole("main").getByRole("button", { name: /^Knowledge/ });
  await knowledgeTrigger.click();
  const picker = page.getByRole("dialog", { name: "Conversation knowledge" });
  await picker.getByRole("checkbox", { name: new RegExp(renamedName) }).check();
  await picker.getByRole("radio", { name: /Full context/ }).check();
  await picker.getByRole("button", { name: "Use knowledge" }).click();
  await expect(knowledgeTrigger).toContainText("1");

  await page.reload();
  await expect(knowledgeTrigger).toContainText("1");
  await knowledgeTrigger.click();
  const persistedPicker = page.getByRole("dialog", { name: "Conversation knowledge" });
  await expect(persistedPicker.getByRole("checkbox", { name: new RegExp(renamedName) }))
    .toBeChecked();
  await expect(persistedPicker.getByRole("radio", { name: /Full context/ })).toBeChecked();
  await persistedPicker.getByRole("checkbox", { name: new RegExp(renamedName) }).uncheck();
  await persistedPicker.getByRole("button", { name: "Remove knowledge" }).click();
  await expect(knowledgeTrigger).not.toContainText("1");

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", {
    name: "Knowledge",
    exact: true,
  }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeVisible();
  const removeFile = page.getByRole("button", { name: `Remove ${filename} from collection` });
  if (testInfo.project.name.includes("mobile")) {
    const removeBox = await removeFile.boundingBox();
    const createBox = await create.boundingBox();
    expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(createBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await removeFile.click();
  await expect(page.getByText(filename, { exact: true })).toBeHidden();

  await page.getByRole("button", { name: `Delete ${renamedName}` }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete collection?" });
  await expect(deleteDialog).toContainText("cannot be undone");
  await deleteDialog.getByRole("button", { name: "Delete collection" }).click();
  await expect(page.getByRole("heading", { name: renamedName })).toBeHidden();
});

test("recovers failed extraction from the file picker and polls until selectable", async ({
  page,
}, testInfo) => {
  const suffix = `${Date.now()}-${testInfo.project.name}`;
  const collectionName = `Recovery ${suffix}`;
  const filename = `broken-${suffix}.pdf`;
  const id = "00000000-0000-4000-8000-000000000099";
  let state: "failed" | "queued" | "ready" = "failed";
  let queuedReads = 0;
  const attachment = () => ({
    id,
    filename,
    mimeType: "application/pdf",
    sizeBytes: 2048,
    state: "ready",
    ingestionStatus: state,
    ingestionError: state === "failed"
      ? "The document parser could not read this unusually detailed test fixture."
      : null,
    ingestedAt: state === "ready" ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
  });

  await page.route(/\/api\/attachments$/, async (route) => {
    if (state === "queued" && queuedReads++ > 0) state = "ready";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [attachment()],
      }),
    });
  });
  await page.route(/\/api\/attachments\/[^/]+\/ingestion\/retry$/, async (route) => {
    state = "queued";
    queuedReads = 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: attachment(),
      }),
    });
  });

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", { name: "Knowledge", exact: true })
    .click();
  await page.getByRole("button", { name: "Create collection" }).click();
  const createDialog = page.getByRole("dialog", { name: "New collection" });
  await createDialog.getByLabel("Name").fill(collectionName);
  await createDialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Add uploaded file" }).click();

  const picker = page.getByRole("dialog", { name: "Add an uploaded file" });
  const retry = picker.getByRole("button", { name: `Retry extraction for ${filename}` });
  await expect(picker.getByText(/Extraction failed: The document parser/)).toBeVisible();
  await expect(picker.getByRole("radio", { name: new RegExp(filename) })).toBeDisabled();
  if (testInfo.project.name.includes("mobile")) {
    expect((await retry.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await retry.click();
  await expect(picker.getByText("Extraction queued — waiting for a worker")).toBeVisible();
  const recovered = picker.getByRole("radio", { name: new RegExp(filename) });
  await expect(recovered).toBeEnabled({ timeout: 7_000 });
  await expect(picker.getByText(/Extraction ready/)).toBeVisible();
  await recovered.check();
  await expect(picker.getByRole("button", { name: "Add file" })).toBeEnabled();
});

test("persists library selection and repairs it after the selected collection is deleted", async ({
  page,
}, testInfo) => {
  const suffix = `${Date.now()}-${testInfo.project.name}`;
  const firstName = `Selection first ${suffix}`;
  const secondName = `Selection second ${suffix}`;
  const storageKey = "dg-chat.active-knowledge-collection";

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", { name: "Knowledge", exact: true })
    .click();
  const createCollection = async (name: string) => {
    await page.getByRole("button", { name: "Create collection" }).click();
    const dialog = page.getByRole("dialog", { name: "New collection" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  };
  await createCollection(firstName);
  await createCollection(secondName);

  type Collection = { id: string; name: string };
  const collections = async (): Promise<Collection[]> => {
    const response = await page.request.get(`${apiURL}/api/collections`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { data: Collection[] }).data;
  };
  const created = await collections();
  const first = created.find((collection) => collection.name === firstName);
  expect(first).toBeTruthy();

  await page.getByRole("button", { name: new RegExp(firstName) }).click();
  await expect(page.getByRole("heading", { name: firstName, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(
    first!.id,
  );

  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", { name: "Chats", exact: true })
    .click();
  await page.reload();
  await openSidebar(page);
  await workspaceNavigation(page).getByRole("button", { name: "Knowledge", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: firstName, exact: true })).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(first!.id);

  await page.getByRole("button", { name: `Delete ${firstName}` }).click();
  await page.getByRole("dialog", { name: "Delete collection?" })
    .getByRole("button", { name: "Delete collection" }).click();
  await expect.poll(async () => {
    const stored = await page.evaluate((key) => sessionStorage.getItem(key), storageKey);
    return stored && stored !== first!.id ? stored : null;
  }).not.toBeNull();
  const fallbackId = await page.evaluate((key) => sessionStorage.getItem(key), storageKey);
  const fallback = (await collections()).find((collection) => collection.id === fallbackId);
  expect(fallback).toBeTruthy();
  await expect(page.getByRole("heading", { name: fallback!.name, exact: true })).toBeVisible();
});

test("extracts uploaded PDF pages and DOCX sections with persisted provenance", async ({
  page,
}, testInfo) => {
  const suffix = `${Date.now()}-${testInfo.project.name}`;
  const pdfName = `manual-${suffix}.pdf`;
  const docxName = `handbook-${suffix}.docx`;
  const pdfText = `PDF browser extraction ${suffix}`;
  const firstSection = `DOCX first section ${suffix}`;
  const secondSection = `DOCX second section ${suffix}`;
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: pdfName,
    mimeType: "application/pdf",
    buffer: documentPdf(pdfText),
  });
  await input.setInputFiles({
    name: docxName,
    mimeType: DOCX_MIME,
    buffer: documentDocx(firstSection, secondSection),
  });

  type Attachment = { id: string; filename: string; ingestionStatus?: string };
  const attachment = async (filename: string): Promise<Attachment | undefined> => {
    const response = await page.request.get(`${apiURL}/api/attachments`);
    if (!response.ok()) return undefined;
    return ((await response.json()) as { data: Attachment[] }).data.find((item) =>
      item.filename === filename
    );
  };
  await expect.poll(async () => (await attachment(pdfName))?.ingestionStatus ?? "missing", {
    timeout: 30_000,
  }).toBe("ready");
  await expect.poll(async () => (await attachment(docxName))?.ingestionStatus ?? "missing", {
    timeout: 30_000,
  }).toBe("ready");

  const pdf = await attachment(pdfName);
  const docx = await attachment(docxName);
  expect(pdf).toBeTruthy();
  expect(docx).toBeTruthy();
  const pdfChunks = await (await page.request.get(`${apiURL}/api/attachments/${pdf!.id}/chunks`))
    .json() as { data: Array<{ content: string; metadata: Record<string, unknown> }> };
  const docxChunks = await (await page.request.get(`${apiURL}/api/attachments/${docx!.id}/chunks`))
    .json() as { data: Array<{ content: string; metadata: Record<string, unknown> }> };
  expect(pdfChunks.data.map((chunk) => chunk.content).join(" ")).toContain(pdfText);
  expect(pdfChunks.data[0].metadata.pageNumber).toBe(1);
  expect(pdfChunks.data[0].metadata.extractorVersion).toBe("builtin-document-v1");
  expect(docxChunks.data.map((chunk) => chunk.content).join(" ")).toContain(firstSection);
  expect(docxChunks.data.map((chunk) => chunk.content).join(" ")).toContain(secondSection);
  expect(new Set(docxChunks.data.map((chunk) => chunk.metadata.section))).toEqual(
    new Set(["1", "2"]),
  );
});
