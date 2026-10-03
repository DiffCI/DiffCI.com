import {readFileSync,writeFileSync} from 'node:fs';
const path='/work/unstorage/test/drivers/db0.test.ts';
const source=readFileSync(path,'utf8');
const before='    afterAll(async () => {\n      const dbCleanup = await driver.getDB();';
if(!source.includes(before))throw Error('Unexpected fixture source');
writeFileSync(path,source.replace(before,'    afterAll(async () => {\n      // testDriver disposes in-memory databases; only persistent MySQL needs table cleanup.\n      if (driver.name !== "mysql") {\n        return;\n      }\n      const dbCleanup = await driver.getDB();'));
