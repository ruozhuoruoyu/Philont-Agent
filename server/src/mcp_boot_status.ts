export interface McpBootServerStatus {
  name: string;
  state: string;
  lastError?: string;
}

export interface McpBootClassification {
  connecting: McpBootServerStatus[];
  unavailable: McpBootServerStatus[];
  shouldWait: boolean;
}

/** Classify boot status without timers or logging, so the grace-period policy is behavior-testable. */
export function classifyMcpBootStatus(
  servers: readonly McpBootServerStatus[],
  final: boolean,
): McpBootClassification {
  const connecting = servers.filter((server) => server.state === 'connecting');
  const down = servers.filter((server) => server.state !== 'connected' && server.state !== 'connecting');
  return {
    connecting,
    unavailable: final ? [...down, ...connecting] : down,
    shouldWait: !final && connecting.length > 0,
  };
}
