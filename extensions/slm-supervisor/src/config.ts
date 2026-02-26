export type SupervisorPolicyConfig = {
  minConfidence: number;
  minGrounding: number;
  supervisorTimeoutMs: number;
};

export const defaultSupervisorPolicy: SupervisorPolicyConfig = {
  minConfidence: 0.75,
  minGrounding: 0.8,
  supervisorTimeoutMs: 2_500,
};
