import { notFound } from "next/navigation";
import { supportAccessEnabled } from "@/auth/support-access-context";
import { SupportLoginForm } from "./support-login-form";
export const dynamic = "force-dynamic";
export default async function SupportLoginPage() {
  if (!await supportAccessEnabled()) notFound();
  return <SupportLoginForm />;
}
