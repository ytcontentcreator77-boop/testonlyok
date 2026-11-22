import { ChatApp } from "../screens/ChatApp";

/** Messaging-only owner panel. Admin tools live in the authenticated ChatApp admin tab. */
export function AdminRoutes(_props: { parts: string[]; query: URLSearchParams }) {
  return <ChatApp />;
}
