export type ChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "unknown";

export interface GitCommitRange {
  baseSha: string;
  headSha: string;
}

export interface ChangedFile {
  path: string;
  changeType: ChangeType;
  oldPath?: string;
  isBinary?: boolean;
  similarityScore?: number;
}

export interface GitDeltaSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  unmerged: number;
  unknown: number;
  total: number;
}

export interface GitDeltaAnalysis {
  empty: boolean;
  configChanged: boolean;
  dependencyManifestChanged: boolean;
  lockfileChanged: boolean;
  workflowChanged: boolean;
  infrastructureChanged: boolean;
  databaseChanged: boolean;
}

export interface GitDelta extends GitCommitRange {
  files: ChangedFile[];
  directories: string[];
  summary: GitDeltaSummary;
  analysis: GitDeltaAnalysis;
}

export interface GitDeltaSuccess {
  success: true;
  delta: GitDelta;
}

export interface GitDeltaFailure {
  success: false;
  error: string;
  partialDelta?: GitDelta;
}

export type GitDeltaResult = GitDeltaSuccess | GitDeltaFailure;
