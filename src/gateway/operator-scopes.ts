export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;
export const TALK_SECRETS_SCOPE = "operator.talk.secrets" as const;
// CW (mesh-gateway): narrow scope for tailscale mesh backend clients. The
// extension and its auth handshake wiring are an April-base feature pending a
// June port; the constant stays so mesh tokens/config remain recognizable.
export const MESH_SCOPE = "operator.mesh" as const;

/** Operator privileges advertised by gateway auth and checked by method policy. */
export type OperatorScope =
  | typeof ADMIN_SCOPE
  | typeof READ_SCOPE
  | typeof WRITE_SCOPE
  | typeof APPROVALS_SCOPE
  | typeof PAIRING_SCOPE
  | typeof TALK_SECRETS_SCOPE
  | typeof MESH_SCOPE;

const KNOWN_OPERATOR_SCOPE_VALUES: readonly OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
  MESH_SCOPE,
];

const KNOWN_OPERATOR_SCOPES: ReadonlySet<OperatorScope> = new Set(KNOWN_OPERATOR_SCOPE_VALUES);

/** Narrows untrusted auth-token scope entries to the gateway's closed scope set. */
export function isOperatorScope(value: unknown): value is OperatorScope {
  return typeof value === "string" && KNOWN_OPERATOR_SCOPES.has(value as OperatorScope);
}
