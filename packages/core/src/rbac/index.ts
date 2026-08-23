export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MARKETING_MANAGER', 'CAMPAIGN_MANAGER', 'ANALYST', 'VIEW_ONLY'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard:read',
  'customers:read', 'customers:read_pii', 'customers:write',
  'events:write',
  'audiences:read', 'audiences:write', 'audiences:activate', 'audiences:delete',
  'destinations:read', 'destinations:manage',
  'sync:read',
  'suppression:read', 'suppression:write',
  'consent:read', 'consent:manage',
  'campaigns:read', 'campaigns:write',
  'analytics:read',
  'audit:read',
  'settings:read', 'settings:manage', 'members:manage',
  'data:export', 'data:import',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];
const READ_ALL: Permission[] = ['dashboard:read', 'customers:read', 'audiences:read', 'destinations:read', 'sync:read',
  'suppression:read', 'consent:read', 'campaigns:read', 'analytics:read', 'settings:read'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ALL,
  ADMIN: ALL,
  MARKETING_MANAGER: [...READ_ALL, 'audiences:write', 'audiences:activate', 'suppression:write', 'campaigns:write', 'customers:write', 'data:import'],
  CAMPAIGN_MANAGER: [...READ_ALL, 'audiences:write', 'audiences:activate', 'campaigns:write'],
  ANALYST: [...READ_ALL, 'audit:read'],
  VIEW_ONLY: READ_ALL,
};

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(public permission: Permission) { super(`Missing permission: ${permission}`); this.name = 'ForbiddenError'; }
}

export interface Principal {
  type: 'USER' | 'API_KEY' | 'SYSTEM';
  id: string | null;
  label: string; // user email or api key name — never customer PII
  organizationId: string;
  role: Role;
  /** API keys carry explicit scopes (subset of permissions). */
  scopes?: Permission[];
}

export function can(p: Principal, permission: Permission): boolean {
  if (p.type === 'SYSTEM') return true;
  if (p.type === 'API_KEY') return (p.scopes ?? []).includes(permission);
  return hasPermission(p.role, permission);
}
export function assertCan(p: Principal, permission: Permission): void {
  if (!can(p, permission)) throw new ForbiddenError(permission);
}
