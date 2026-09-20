/**
 * 本地附件文本提取（sidepanel 用）。
 *
 * 边界：扩展无权按路径读任意本地文件，必须由用户在文件选择框里显式挑选
 * （选择动作本身即授权）。解析在 sidepanel 内完成，文本随任务发给 LLM。
 *
 * 支持：.xlsx/.xls（SheetJS → 每表 CSV 风格文本）、.docx（mammoth → 纯文本）。
 * 防御上限：每表 200 行 × 30 列，总量 20000 字符，超出截断并标注。
 */
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_CHARS = 20000;

export const ATTACH_ACCEPT = '.xlsx,.xls,.docx';

export async function extractAttachmentText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  let text: string;
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    text = await extractExcel(file);
  } else if (name.endsWith('.docx')) {
    text = await extractDocx(file);
  } else {
    throw new Error('不支持的文件类型（仅支持 .xlsx / .xls / .docx）');
  }
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}\n…（内容过长已截断，共 ${text.length} 字符）`;
  }
  return text;
}

async function extractExcel(file: File): Promise<string> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  if (wb.SheetNames.length === 0) throw new Error('Excel 文件里没有工作表');
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });
    const truncated = rows.length > MAX_ROWS;
    const lines = rows
      .slice(0, MAX_ROWS)
      .map((r) => r.slice(0, MAX_COLS).map((c) => String(c ?? '').trim()).join(', '));
    let part = lines.join('\n');
    if (truncated) part += `\n…（还有 ${rows.length - MAX_ROWS} 行未显示）`;
    parts.push(wb.SheetNames.length > 1 ? `工作表「${sheetName}」:\n${part}` : part);
  }
  return parts.join('\n\n');
}

async function extractDocx(file: File): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const text = result.value.trim();
  if (!text) throw new Error('Word 文档里没有可提取的文本');
  return text;
}
