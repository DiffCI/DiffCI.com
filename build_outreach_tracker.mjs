import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const outDir = 'outputs/diffci-outreach-tracker';
await fs.mkdir(outDir, { recursive: true });
const wb = Workbook.create();
const ws = wb.worksheets.add('Outreach');
ws.showGridLines = false;
ws.getRange('A1:J1').merge();
ws.getRange('A1').values = [['DiffCI Outreach Tracker']];
ws.getRange('A2:J2').merge();
ws.getRange('A2').values = [['Prospective shadow-mode CI pilots']];
ws.getRange('A4:J12').values = [
  ['Date added','Organisation','Repository','Contact','Email / handle','Channel','Subject','Status','Next action','Source / message ID'],
  [new Date('2026-09-09'),'Stately','statelyai/xstate','David Khourshid','david@stately.ai','Email','Read-only CI pilot for XState','Draft ready','Review and send if approved',''],
  [new Date('2026-09-09'),'Inngest','inngest/inngest-js','Inngest partnerships','partnerships@inngest.com','Email','Read-only CI pilot for Inngest','Draft ready','Review and send if approved',''],
  [new Date('2026-09-23'),'Caskey Engineering','9 private repositories','Eric Caskey','e@ericcaskey.com','Email','A measurement-only DiffCI pilot for one of your repositories','Sent','Follow up 2026-09-30 if no reply','Gmail 1a0ced953bc3a53a | https://caskeycoding.com/blog/june-sdd-production-numbers'],
  [new Date('2026-09-23'),'airCloset','Private repositories','Ryosuke “Ryan” Tsuji','r.tsuji@air-closet.com','Email','Test selection on top of airCloset’s faster CI runners','Sent','Follow up 2026-09-30 if no reply','Gmail 1a0ced956231546f | https://ryantsuji.dev/posts/namespace-ci-migration'],
  [new Date('2026-09-23'),'OpenVoxProject','OpenVoxProject/openvox','OpenVox maintainers / Tim Meusel','openvox@voxpupuli.org; tim@bastelfreak.de','Email','Proposal: OpenVox change-aware CI benchmark','Sent','Follow up 2026-09-30 if no reply','Gmail 1a0ced95ac29067a | https://bastelfreak.de/cfgmgmtcamp2026/openvox.html'],
  [new Date('2026-09-23'),'Reddit r/vibecoding','Private repository','u/Successful_Dog1904','u/Successful_Dog1904','Reddit DM','Possible next step for reducing your CI workload','Response ready','User to post or send on Reddit','https://www.reddit.com/r/vibecoding/comments/1vlwobw/github_billing_feels_insane/'],
  [new Date('2026-09-23'),'Reddit r/devops','Self-hosted GitHub Actions','u/markmcw','u/markmcw','Reddit DM','Measurement-only pilot for your self-hosted runner workload','Response ready','User to send on Reddit','https://www.reddit.com/r/devops/comments/1po8hj5/github_actions_introducing_a_perminute_fee_for/'],
  [new Date('2026-09-23'),'Reddit r/devops','Jenkins / AWS pipelines','u/CallofDutyReznov454','u/CallofDutyReznov454','Reddit comment','Measure the slowest CI stage before migrating','Response ready','User to comment on Reddit','https://www.reddit.com/r/devops/comments/1w022k1/fastest_way_to_ci/'],
];
ws.getRange('A1:J1').format = { font:{name:'Arial',size:16,bold:true,color:'#1F2937'}, verticalAlignment:'center' };
ws.getRange('A2:J2').format = { font:{name:'Arial',size:10,italic:true,color:'#6B7280'} };
ws.getRange('A4:J4').format = { fill:'#1F4E78', font:{name:'Arial',bold:true,color:'#FFFFFF'}, horizontalAlignment:'center', verticalAlignment:'center', wrapText:true };
ws.getRange('A5:J12').format = { font:{name:'Arial',size:10,color:'#1F2937'}, verticalAlignment:'center', wrapText:true };
ws.getRange('A4:J12').format.borders = { preset:'all',style:'thin',color:'#D9E2F3' };
ws.getRange('A5:A12').format.numberFormat = 'yyyy-mm-dd';
ws.getRange('H5:H12').conditionalFormats.add('containsText', { text:'Sent', format:{fill:'#E2F0D9',font:{color:'#375623',bold:true}} });
ws.getRange('H5:H12').conditionalFormats.add('containsText', { text:'Response ready', format:{fill:'#FFF2CC',font:{color:'#7F6000'}} });
for (const [col,width] of [['A',95],['B',145],['C',175],['D',170],['E',220],['F',100],['G',250],['H',105],['I',190],['J',300]]) ws.getRange(`${col}1`).format.columnWidthPx = width;
ws.getRange('1:1').format.rowHeightPx = 28;
ws.getRange('2:2').format.rowHeightPx = 20;
ws.getRange('4:4').format.rowHeightPx = 38;
ws.getRange('5:12').format.rowHeightPx = 72;
ws.freezePanes.freezeRows(4);
const table = ws.tables.add('A4:J12',true,'OutreachTracker'); table.style='TableStyleMedium2'; table.showBandedColumns=false;
const check = await wb.inspect({kind:'table',range:'Outreach!A1:J12',include:'values',tableMaxRows:15,tableMaxCols:12});
console.log(check.ndjson);
const errors = await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:100},summary:'final formula error scan'});
console.log(errors.ndjson);
const render = await wb.render({sheetName:'Outreach',range:'A1:J12',scale:1.1,format:'png'});
await fs.writeFile(`${outDir}/preview.png`,new Uint8Array(await render.arrayBuffer()));
const file = await SpreadsheetFile.exportXlsx(wb);
await file.save(`${outDir}/DiffCI Outreach Tracker.xlsx`);
