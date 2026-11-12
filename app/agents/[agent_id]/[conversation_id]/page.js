import { cookies, headers } from "next/headers";
import { isStaffMode, getStaffIdentity, getProviderAuth } from "../../../../src/lib/staffAuth.mjs";
import AgentChatClient from "../AgentChatClient";

/**
 * Server component — fetches both agentDetails and initialHistory
 * from the /api/agents proxy using the muapi_key cookie, then renders
 * the client chat component with existing conversation messages pre-loaded.
 *
 * URL: /agents/[agent_id]/[conversation_id]
 */
export async function generateMetadata({ params }) {
  return {
    title: `Agent Chat — Open Generative AI`,
  };
}

const BASE_URL = 'https://api.muapi.ai';

async function fetchAgentDetails(agentId, apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `${BASE_URL}/agents/by-slug/${encodeURIComponent(agentId)}`,
      {
        cache: "no-store",
        headers: { "x-api-key": apiKey },
      }
    );
    if (res.ok) return await res.json();
    
    if (agentId.length > 20) {
      const resId = await fetch(
        `${BASE_URL}/agents/${encodeURIComponent(agentId)}`,
        {
          cache: "no-store",
          headers: { "x-api-key": apiKey },
        }
      );
      if (resId.ok) return await resId.json();
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchHistory(agentId, conversationId, apiKey) {
  if (!apiKey) return null;
  try {
    // Try by slug first
    const res = await fetch(
      `${BASE_URL}/agents/by-slug/${encodeURIComponent(agentId)}/${encodeURIComponent(conversationId)}`,
      {
        cache: "no-store",
        headers: { "x-api-key": apiKey },
      }
    );
    if (res.ok) return await res.json();
    
    // Fallback to direct agent ID if needed
    if (agentId.length > 20) {
      const resId = await fetch(
        `${BASE_URL}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(conversationId)}`,
        {
          cache: "no-store",
          headers: { "x-api-key": apiKey },
        }
      );
      if (resId.ok) return await resId.json();
    }
    return null;
  } catch {
    return null;
  }
}

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

export default async function AgentConversationPage({ params }) {
  const { agent_id, conversation_id } = await params;
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

  console.log(`[ConvPage] Loading for agent: ${agent_id}, conv: ${conversation_id}, hasKey: ${!!apiKey}`);

  const [agentDetails, initialHistory, userData] = await Promise.all([
    fetchAgentDetails(agent_id, apiKey),
    fetchHistory(agent_id, conversation_id, apiKey),
    fetchUserData(apiKey)
  ]);

  return (
    <AgentChatClient 
      agentDetails={agentDetails} 
      initialHistory={initialHistory} 
      userData={staffMode ? {
        staffMode: true,
        email: identity.email,
        balance: Number(userData?.balance) || 0,
        providerConfigured: Boolean(apiKey),
      } : userData}
    />
  );
}
