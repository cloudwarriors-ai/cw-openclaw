// Shared admission only; native permissions and confirmation live in the app.
import type { BackendProfile } from "./backend-profile.js";

// Verified production node, planned dedicated VIP port; ingress is not live yet.
// Activation still requires API/ACL proof. Never add test/public/wildcard origins.
const PRODUCTION_ORIGINS: readonly string[] = Object.freeze([
  "https://prod.tailcc6c5f.ts.net:9443",
]);
export const PRODUCTION_CORE_TOOLS = {
  scopely_create_pricing_item: "pricing.items.create",
  scopely_update_pricing_item: "pricing.items.update",
  scopely_create_scoping_card: "catalog.scoping_cards.create",
  scopely_update_scoping_card: "catalog.scoping_cards.update",
  scopely_delete_scoping_card: "catalog.scoping_cards.delete",
  scopely_update_project_type: "catalog.project_types.update",
  scopely_update_deployment_type: "catalog.deployment_types.update",
} as const;
export const PRODUCTION_SUPPORT = [
  "ops.confirm",
  "ops.cancel",
  "ops.pending",
  "ops.approvers.check",
  "ops.approvers.list",
] as const;
export function isReviewedProductionOrigin(origin: string, reviewed = PRODUCTION_ORIGINS): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && reviewed.includes(origin);
  } catch {
    return false;
  }
}
export function productionCoreEnabled(p: BackendProfile, reviewed = PRODUCTION_ORIGINS): boolean {
  return (
    p.env === "prod" &&
    p.mode === "read-write" &&
    p.authMode === "service-token" &&
    p.productionCoreWrites === true &&
    !p.hostHeader &&
    isReviewedProductionOrigin(p.baseUrl, reviewed) &&
    p.allowedHosts.includes(new URL(p.baseUrl).host) &&
    p.allowedHosts.every((host) => isReviewedProductionOrigin(`https://${host}`, reviewed))
  );
}
// Dedicated gateway-only Docker ingress. Public dev hosts and the person
// connector are deliberately excluded even though they share the native DB.
export function isReviewedDevelopmentProfile(p: BackendProfile): boolean {
  return (
    p.env === "dev" &&
    p.authMode === "service-token" &&
    p.productionCoreWrites !== true &&
    p.baseUrl === "http://vip-noob-bot-native:8000" &&
    !p.hostHeader &&
    p.allowedHosts.length === 1 &&
    p.allowedHosts[0] === "vip-noob-bot-native:8000"
  );
}
export function developmentCoreEnabled(p: BackendProfile): boolean {
  return (
    p.mode === "read-write" && p.developmentCoreWrites === true && isReviewedDevelopmentProfile(p)
  );
}
export function productionCapabilityAllowed(capability: string): boolean {
  return [...Object.values(PRODUCTION_CORE_TOOLS), ...PRODUCTION_SUPPORT].includes(
    capability as (typeof PRODUCTION_SUPPORT)[number],
  );
}
export function nativeWriteScope(
  p: BackendProfile,
  channel: string | undefined,
  reviewed = PRODUCTION_ORIGINS,
): string | undefined {
  const local =
    p.env === "local" && p.mode === "read-write" && p.baseUrl === "http://127.0.0.1:8100";
  const reviewedCore =
    (productionCoreEnabled(p, reviewed) || developmentCoreEnabled(p)) &&
    /^[a-f0-9]{32}@conference\.xmpp\.zoom\.us$/.test(channel ?? "");
  return channel && (local || reviewedCore)
    ? JSON.stringify([
        p.env,
        p.mode,
        p.baseUrl,
        p.authMode,
        channel,
        p.productionCoreWrites === true,
        p.developmentCoreWrites === true,
      ])
    : undefined;
}
