// Types for verify-audit-chain.mjs (the script itself stays plain Node, no build step).
export const GENESIS_HASH: string;
export function canonicalJson(value: unknown): string;
export function sha256Hex(data: string | Uint8Array): string;
export function recordHash(record: Record<string, unknown>): string;
export type VerifyOptions = {
  prevHash?: string;
  firstSeq?: number;
  allowTornTail?: boolean;
  requirePaired?: boolean;
  anchor?: { last_seq: number; head_hash: string; bytes?: number; file_sha256?: string };
  v1?: { sha256?: string; bytes?: number; lines?: number };
};
export type VerifyResult =
  | {
      ok: true;
      head: { seq: number; hash: string; env?: string };
      firstSeq: number;
      hashes: Map<number, string>;
      unpaired: number[];
      warnings: string[];
      epoch: Record<string, unknown> | null;
    }
  | { ok: false; reason: string; seq: number | null; line: number | null; warnings: string[] };
export function verifyChain(text: string, opts?: VerifyOptions): VerifyResult;
export function verifyFile(bytes: Buffer, opts?: VerifyOptions): VerifyResult;
export function main(argv: string[]): number;
