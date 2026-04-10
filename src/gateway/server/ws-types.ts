import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
  authUser?: string;
  authMethod?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
};
