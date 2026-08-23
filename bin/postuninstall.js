#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.aikombinat');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.clitrigger');

const existingDirs = [CONFIG_DIR, LEGACY_CONFIG_DIR].filter(d => fs.existsSync(d));

if (existingDirs.length > 0) {
  console.log(`
AIKombinat가 제거되었습니다.

설정 및 데이터가 아래 경로에 남아 있습니다:
${existingDirs.map(d => `  ${d}`).join('\n')}

완전히 제거하려면 해당 폴더를 수동으로 삭제해주세요:
${existingDirs.map(d => `  rm -rf ${d}`).join('\n')}
`.trim());
}
