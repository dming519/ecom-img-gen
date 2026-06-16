import type { ProductMaterialFile, ProductMaterialKind } from "./types";

export const PRODUCT_MATERIAL_ACCEPT = [
  "image/*",
  ".pdf",
  "application/pdf",
  ".doc",
  ".docx",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt",
  ".pptx",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls",
  ".xlsx",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html",
  ".htm",
  "text/html",
  ".csv",
  "text/csv",
  ".json",
  "application/json",
  ".xml",
  "application/xml",
  "text/xml",
].join(",");

export const MAX_PRODUCT_MATERIAL_FILES = 10;
export const MAX_PRODUCT_MATERIAL_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCT_MATERIAL_MARKDOWN_CHARS = 60_000;
export const MAX_PRODUCT_MATERIAL_TOTAL_CHARS = 160_000;

const MAX_TABLE_ROWS = 80;
const MAX_TABLE_COLUMNS = 12;
const MAX_PDF_PAGES = 80;
const MAX_PPTX_SLIDES = 80;

const MATERIAL_KIND_LABEL: Record<ProductMaterialKind, string> = {
  pdf: "PDF",
  word: "Word",
  powerpoint: "PPT",
  excel: "Excel",
  html: "HTML",
  csv: "CSV",
  json: "JSON",
  xml: "XML",
};

function createMaterialId() {
  return crypto.randomUUID?.() ?? `material-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function getProductMaterialKindLabel(kind: ProductMaterialKind) {
  return MATERIAL_KIND_LABEL[kind];
}

export function getProductMaterialKind(file: File): ProductMaterialKind | null {
  const extension = getExtension(file.name);
  const mimeType = file.type.toLowerCase();
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (
    extension === "doc" ||
    extension === "docx" ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "word";
  }
  if (
    extension === "ppt" ||
    extension === "pptx" ||
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "powerpoint";
  }
  if (
    extension === "xls" ||
    extension === "xlsx" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "excel";
  }
  if (extension === "html" || extension === "htm" || mimeType === "text/html") return "html";
  if (extension === "csv" || mimeType === "text/csv") return "csv";
  if (extension === "json" || mimeType === "application/json") return "json";
  if (extension === "xml" || mimeType === "application/xml" || mimeType === "text/xml") return "xml";
  return null;
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function truncateMarkdown(markdown: string, limit = MAX_PRODUCT_MATERIAL_MARKDOWN_CHARS) {
  const normalized = normalizeWhitespace(markdown);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}\n\n> 文件内容较长，已截取前 ${limit} 个字符用于辅助生图。`;
}

function escapeTableCell(value: unknown) {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function rowsToMarkdownTable(rows: unknown[][]) {
  const cleanRows = rows
    .map((row) => row.slice(0, MAX_TABLE_COLUMNS).map((cell) => escapeTableCell(cell)))
    .filter((row) => row.some(Boolean))
    .slice(0, MAX_TABLE_ROWS);
  if (!cleanRows.length) return "";

  const width = Math.max(...cleanRows.map((row) => row.length));
  const padded = cleanRows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const first = padded[0] ?? [];
  const rest = padded.slice(1);
  const header = first.map((cell, index) => cell || `字段 ${index + 1}`);
  const separator = header.map(() => "---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rest.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function readFileAsText(file: File) {
  return file.text();
}

async function convertHtmlToMarkdown(html: string) {
  const { default: TurndownService } = await import("turndown");
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  return turndown.turndown(html);
}

async function convertPdf(file: File) {
  const [pdfjsLib, pdfWorker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push(`## 第 ${pageNumber} 页\n\n${text}`);
    page.cleanup();
  }

  await loadingTask.destroy();
  return pages.join("\n\n");
}

async function convertWord(file: File) {
  const extension = getExtension(file.name);
  if (extension === "doc") {
    throw new Error("浏览器端暂不支持旧版 .doc，请另存为 .docx 后上传。");
  }
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return convertHtmlToMarkdown(result.value);
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

async function convertPowerPoint(file: File) {
  const extension = getExtension(file.name);
  if (extension === "ppt") {
    throw new Error("浏览器端暂不支持旧版 .ppt，请另存为 .pptx 后上传。");
  }
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideEntries = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => {
      const left = Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      const right = Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      return left - right;
    })
    .slice(0, MAX_PPTX_SLIDES);

  const slides: string[] = [];
  for (const [index, path] of slideEntries.entries()) {
    const xml = await zip.files[path]?.async("text");
    if (!xml) continue;
    const text = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
      .map((match) => decodeXmlEntities(match[1] ?? "").trim())
      .filter(Boolean)
      .join("\n");
    if (text) slides.push(`## 第 ${index + 1} 页\n\n${text}`);
  }
  return slides.join("\n\n");
}

async function convertExcel(file: File) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return "";
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
    });
    const table = rowsToMarkdownTable(rows);
    return table ? `## ${sheetName}\n\n${table}` : "";
  })
    .filter(Boolean)
    .join("\n\n");
}

async function convertHtml(file: File) {
  return convertHtmlToMarkdown(await readFileAsText(file));
}

async function convertCsv(file: File) {
  const { default: Papa } = await import("papaparse");
  const text = await readFileAsText(file);
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
  });
  if (result.errors.length) {
    throw new Error(result.errors[0]?.message || "CSV 解析失败");
  }
  return rowsToMarkdownTable(result.data);
}

async function convertJson(file: File) {
  const text = await readFileAsText(file);
  try {
    return `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2)}\n\`\`\``;
  } catch {
    return `\`\`\`json\n${text.trim()}\n\`\`\``;
  }
}

async function convertXml(file: File) {
  const text = await readFileAsText(file);
  return `\`\`\`xml\n${text.trim()}\n\`\`\``;
}

async function convertToMarkdown(file: File, kind: ProductMaterialKind) {
  if (kind === "pdf") return convertPdf(file);
  if (kind === "word") return convertWord(file);
  if (kind === "powerpoint") return convertPowerPoint(file);
  if (kind === "excel") return convertExcel(file);
  if (kind === "html") return convertHtml(file);
  if (kind === "csv") return convertCsv(file);
  if (kind === "json") return convertJson(file);
  return convertXml(file);
}

export async function convertProductMaterialFile(file: File): Promise<ProductMaterialFile> {
  const kind = getProductMaterialKind(file);
  if (!kind) {
    throw new Error(`不支持的商品资料格式：${file.name}`);
  }
  if (file.size > MAX_PRODUCT_MATERIAL_BYTES) {
    throw new Error(`商品资料文件过大（>25MB）：${file.name}`);
  }

  const markdown = truncateMarkdown(await convertToMarkdown(file, kind));
  if (!markdown) {
    throw new Error(`未能从商品资料中读取到文本：${file.name}`);
  }

  return {
    id: createMaterialId(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind,
    markdown,
  };
}

export function createProductMaterialsMarkdown(materials: ProductMaterialFile[]) {
  const chunks = materials
    .filter((item) => item.markdown.trim())
    .map((item) => [
      `## ${item.name}`,
      "",
      `来源类型：${getProductMaterialKindLabel(item.kind)}`,
      "",
      item.markdown.trim(),
    ].join("\n"));

  return truncateMarkdown(chunks.join("\n\n---\n\n"), MAX_PRODUCT_MATERIAL_TOTAL_CHARS);
}
