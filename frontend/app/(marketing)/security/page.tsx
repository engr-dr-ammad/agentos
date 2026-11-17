import { Prose } from "../prose";

export const metadata = { title: "Security and privacy" };

export default function Security() {
  return (
    <Prose title="Security and privacy" lead="How AgentOS keeps each organisation's data separate, keeps people in control of agents, and supports GDPR and EU AI Act work.">
      <section><h2>Tenant isolation</h2><p>Every organisation-owned table has a PostgreSQL row-level-security policy. The application connects as a non-owner role and sets the organisation for each transaction, so a query can only ever see one tenant&apos;s rows. Background jobs, retrieval, analytics and file processing run under the same scoping.</p></section>
      <section><h2>Agents are controlled software</h2><ul><li>Agents only receive the data each step passes to them and the knowledge bases they are explicitly linked to.</li><li>External actions go through a server-side tool gateway that checks the tenant, connection, workflow permission, approval, rate limit and idempotency key.</li><li>An approval is bound to a hash of the exact action. If anything changes, the gateway refuses and fresh approval is needed.</li><li>Spending limits, step limits, timeouts and retry limits are enforced by the platform, not by prompts.</li></ul></section>
      <section><h2>Prompt injection</h2><p>Customer messages and retrieved documents are wrapped and labelled as untrusted data. Even if a model is manipulated, it cannot send, pay or delete anything, because it has no direct access to integrations. Its output is only a proposal that passes validation, policy checks and human approval.</p></section>
      <section><h2>Credentials</h2><p>Model API keys and integration secrets are encrypted at rest (Fernet / AES-128-CBC + HMAC) and decrypted only inside the gateway or model adapter. They are never returned to the browser or included in prompts.</p></section>
      <section><h2>Accounts</h2><p>Passwords are hashed with Argon2id. TOTP multi-factor authentication, session revocation, role-based access (owner, admin, manager, employee, viewer), CSRF protection and an append-only audit log are built in.</p></section>
      <section><h2>GDPR</h2><p>Data-subject access and erasure workflows, retention settings, data minimisation in agent prompts, and an export of execution records. Processor agreements and sub-processor registers are maintained by the operator of each deployment.</p></section>
      <section><h2>EU AI Act</h2><p>A structured self-assessment records intended purpose, deployment context, possible prohibited or high-risk categories and transparency duties. It never marks a system as compliant on its own. Potentially high-risk uses are flagged for qualified legal review.</p></section>
    </Prose>
  );
}
