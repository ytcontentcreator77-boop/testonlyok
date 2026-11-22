import { ChatApp } from "../screens/ChatApp";

/** Messaging-only owner panel. Admin tools live in the authenticated ChatApp admin tab. */
export function AdminRoutes() {
  return <ChatApp />;
}
