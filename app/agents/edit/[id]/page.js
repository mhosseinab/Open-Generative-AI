import { cookies, headers } from "next/headers";
import { isStaffMode, getStaffIdentity, getProviderAuth } from "../../../../src/lib/staffAuth.mjs";
import AgentEditClient from "./AgentEditClient";

const BASE_URL = 'https://api.muapi.ai';

async function fetchUserData(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${BASE_URL}/api/v1/account/balance`, {
      cache: "no-store",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function EditAgentPage({ params }) {
  const { id } = await params; // although we don't use id on server here, it's used by useParams in client
  const staffMode = isStaffMode();
  let identity = null;
  let apiKey = null;
  if (staffMode) {
    const request = { headers: await headers() };
    try {
      identity = await getStaffIdentity(request);
    } catch {
      return <p role="alert">Your staff session is invalid or expired. Sign in through Cloudflare Access again.</p>;
    }
    try {
      ({ apiKey } = await getProviderAuth(request));
    } catch {
      // Allow the staff interface to load while an administrator installs the provider key.
    }
  } else {
    const cookieStore = await cookies();
    apiKey = cookieStore.get("muapi_key")?.value;
  }

  const userData = await fetchUserData(apiKey);

  return (
    <AgentEditClient userData={staffMode ? {
        staffMode: true,
        email: identity.email,
        balance: Number(userData?.balance) || 0,
        providerConfigured: Boolean(apiKey),
      } : userData} />
  );
}
