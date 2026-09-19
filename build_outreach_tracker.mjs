import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const outDir = 'outputs/diffci-outreach-tracker';
await fs.mkdir(outDir, { recursive: true });
const wb = Workbook.create();
const ws = wb.worksheets.add('Outreach');
ws.showGridLines = false;
ws.getRange('A1:H1').merge();
ws.getRange('A1').values = [['DiffCI Outreach Tracker']];
ws.getRange('A2:H2').merge();
ws.getRange('A2').values = [['Prospective shadow-mode CI pilots']];
ws.getRange('A4:H6').values = [
  ['Date added','Organisation','Repository','Contact','Email','Subject','Status','Next action'],
  ['2026-09-09','Stately','statelyai/xstate','David Khourshid','david@stately.ai','Read-only CI pilot for XState','Draft ready','Review and send if approved'],
  ['2026-09-09','Inngest','inngest/inngest-js','Inngest partnerships','partnerships@inngest.com','Read-only CI pilot for Inngest','Draft ready','Review and send if approved'],
];
ws.getRange('A1:H1').format = { font:{name:'Arial',size:16,bold:true,color:'#1F2937'}, verticalAlignment:'center' };
ws.getRange('A2:H2').format = { font:{name:'Arial',size:10,italic:true,color:'#6B7280'} };
ws.getRange('A4:H4').format = { fill:'#1F4E78', font:{name:'Arial',bold:true,color:'#FFFFFF'}, horizontalAlignment:'center', verticalAlignment:'center' };
ws.getRange('A5:H6').format = { font:{name:'Arial',size:10,color:'#1F2937'}, verticalAlignment:'center', wrapText:true };
ws.getRange('A4:H6').format.borders = { preset:'outside',style:'thin',color:'#B7C9D6' };
ws.getRange('A4:H6').format.borders = { preset:'all',style:'thin',color:'#D9E2F3' };
ws.getRange('A5:A6').format.numberFormat = 'yyyy-mm-dd';
ws.getRange('G5:G6').format.fill = '#E2F0D9';
for (const [col,width] of [['A',95],['B',110],['C',170],['D',145],['E',210],['F',220],['G',100],['H',180]]) ws.getRange(`${col}1`).format.columnWidthPx = width;
ws.getRange('1:1').format.rowHeightPx = 28;
ws.getRange('2:2').format.rowHeightPx = 20;
ws.getRange('4:4').format.rowHeightPx = 25;
ws.getRange('5:6').format.rowHeightPx = 45;
ws.freezePanes.freezeRows(4);
const table = ws.tables.add('A4:H6',true,'OutreachTracker'); table.style='TableStyleMedium2'; table.showBandedColumns=false;
const check = await wb.inspect({kind:'table',range:'Outreach!A1:H6',include:'values',tableMaxRows:10,tableMaxCols:10});
console.log(check.ndjson);
const render = await wb.render({sheetName:'Outreach',range:'A1:H6',scale:1.5,format:'png'});
await fs.writeFile(`${outDir}/preview.png`,new Uint8Array(await render.arrayBuffer()));
const file = await SpreadsheetFile.exportXlsx(wb);
await file.save(`${outDir}/DiffCI Outreach Tracker.xlsx`);
