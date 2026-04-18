import { JSONFilePreset } from "lowdb/node";
import type { Finding, FindingClass } from "./scanners/normalize.js";

export type SessionStatus = "pending" | "running" | "blocked" | "completed" | "stopped" | "failed";

export interface IssueRecord {
  fingerprint: string;
  class: FindingClass;
  issueNumber: number;
  repo: string;
  url: string;
  createdAt: string;
}

export interface SessionRecord {
  fingerprint: string;
  issueNumber: number;
  devinSessionId: string;
  devinSessionUrl: string;
  class: FindingClass;
  status: SessionStatus;
  prUrl?: string;
  ciPassedFirstTry?: boolean;
  iterations: number;
  structuredOutput?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RunRecord {
  startedAt: string;
  finishedAt?: string;
  findings: number;
  newIssues: number;
  sessionsCreated: number;
  sessionsCompleted: number;
  prsOpened: number;
}

export interface DbShape {
  findings: Finding[];
  issues: IssueRecord[];
  sessions: SessionRecord[];
  runs: RunRecord[];
}

const defaults: DbShape = { findings: [], issues: [], sessions: [], runs: [] };

export async function openState(path: string) {
  return JSONFilePreset<DbShape>(path, defaults);
}

export type StateDb = Awaited<ReturnType<typeof openState>>;
