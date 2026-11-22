// The Signal's declared identity: one place to change who the collector says it is.
// Every outbound request from the collector uses DEFAULT_USER_AGENT unless a source's usage
// policy asks for a specific format, in which case it is listed in USER_AGENT_OVERRIDES.

export const IDENTITY = {
  organization: 'RadMage Labs',
  application: 'The Signal',
  version: '0.1.0',
  contact: 'radmageirl@radmagelabs.com',
  website: 'https://radmagelabs.com/signal/',
} as const;

/** Product token used when matching robots.txt groups. */
export const ROBOTS_TOKEN = 'TheSignal';

export const DEFAULT_USER_AGENT = `TheSignal/${IDENTITY.version} (${IDENTITY.website}; ${IDENTITY.contact})`;

/**
 * Source-specific formats required by a publisher's access policy.
 * - sec: SEC fair-access policy asks for "Company Name AdminContact@domain".
 */
export const USER_AGENT_OVERRIDES: Record<string, string> = {
  sec: `${IDENTITY.organization} ${IDENTITY.contact}`,
};

export function userAgentFor(sourceId: string): string {
  return USER_AGENT_OVERRIDES[sourceId] ?? DEFAULT_USER_AGENT;
}
