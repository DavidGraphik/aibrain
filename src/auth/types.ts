export type AuthProvider = "demo" | "local";
export type AuthMode = "demo" | "supabase" | "private-owner" | "unavailable";

export type AuthSession = {
  provider: AuthProvider;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string | null;
  };
  tenant: {
    id: string;
    name: string;
  };
  expiresAt: string;
  support?: { actorEmail: string; expiresAt: string; preview?: { threadId: string; appId: string } };
};

export type DemoAccount = {
  id: string;
  name: string;
  email: string;
  tenantId: string;
  tenantName: string;
  productName: string;
  description: string;
};
