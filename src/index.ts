/**
 * Sentinal Shared Library
 * 
 * Common utilities and checkers used by both Claude Code and OpenCode targets.
 * This module provides reusable quality enforcement functions.
 */

export { checkFileLength, type FileLengthResult } from "./utils/file-length.js";
export { isTestFile, getExpectedTestPaths, isTrivialEdit } from "./utils/tdd.js";
export { isNestFile, checkNestPatterns, type NestCheckResult } from "./checkers/nestjs.js";
export { detectPackageManager, detectTestRunner, detectFramework, type PackageManager, type TestRunner, type Framework } from "./checkers/detect.js";
