export * from './workspace.js';
export * from './cli-guard.js';
export {
  UNEXPECTED_FS_WRITE_MESSAGE,
  isTestRuntimePathAllowed,
  assertTestRuntimePathAllowed,
  registerApprovedTestRoot,
  unregisterApprovedTestRoot,
} from '../utils/test-fs-guard.js';


