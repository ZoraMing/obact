/**
 * 表单与文件夹具的接口（PRD 9.3，FR-35）：报表下载。
 *
 * GET /api/forms-files/report.csv?seed=&rows= → CSV 附件：content-disposition: attachment（ASCII 文件名 + RFC 5987 中文文件名），
 * 正文以 UTF-8 BOM 开头（Excel 打开中文不乱码），CRLF 换行，含逗号或引号的字段按 RFC 4180 加引号。内容只由 seed 与行号决定。
 */
import type { FixtureHandler } from '../server.ts';

export const REPORT_FILENAME = 'report.csv';
export const REPORT_FILENAME_CN = '订单报表.csv';
const HEADER = ['日期', '订单号', '客户', '金额', '备注'];
const CUSTOMERS = ['张伟', '王芳', '李娜', '刘洋', '陈静', '杨磊'];
const NOTES = ['', '加急', '含发票, 需盖章', '客户说"尽快"', '分批发货'];

/** RFC 4180：含逗号、引号、换行的字段加引号，引号写两次。 */
const csvField = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** 完整的 CSV 文本（含 BOM，CRLF 换行，末尾有换行）。第 i 行的备注依次循环，保证含逗号与引号的字段都会出现。 */
export function reportCsv(seed: number, rows: number): string {
  const lines: string[][] = [HEADER];
  for (let i = 0; i < rows; i++) {
    lines.push([
      `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`,
      `SO${String(seed).padStart(3, '0')}${String(i + 1).padStart(4, '0')}`,
      CUSTOMERS[(seed + i * 5) % CUSTOMERS.length] as string,
      (((seed * 7919 + i * 104729) % 1_000_000) / 100).toFixed(2),
      NOTES[i % NOTES.length] as string,
    ]);
  }
  return `﻿${lines.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

const report: FixtureHandler = ({ url, res, json }) => {
  const seed = Number(url.searchParams.get('seed') ?? 1);
  const rows = Number(url.searchParams.get('rows') ?? 10);
  if (!Number.isInteger(seed) || !Number.isInteger(rows) || rows < 0 || rows > 10_000) {
    return json({ error: 'seed 必须是整数，rows 为 0 ~ 10000 的整数' }, 400);
  }
  const body = Buffer.from(reportCsv(seed, rows), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${REPORT_FILENAME}"; filename*=UTF-8''${encodeURIComponent(REPORT_FILENAME_CN)}`,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export const routes: Record<string, FixtureHandler> = {
  '/api/forms-files/report.csv': report,
};
